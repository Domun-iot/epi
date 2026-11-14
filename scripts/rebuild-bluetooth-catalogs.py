#!/usr/bin/env python3
"""Rebuild offline Bluetooth tables from pinned upstream files and maintained local records.

Python 3.11+, standard library only. Runtime builds use the committed JSON files.
The cache is optional; every input is verified against its pinned SHA-256.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
CONFIG = Path(__file__).resolve().parent / 'catalogs'

def encoded(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode()

def obtain(source, cache):
    path = cache / source['repository'].replace('/', '--') / source['path']
    if path.exists():
        raw = path.read_bytes()
    else:
        url = f"https://raw.githubusercontent.com/{source['repository']}/{source['commit']}/{source['path']}"
        request = urllib.request.Request(url, headers={'User-Agent': 'epi-catalog-rebuild'})
        raw = urllib.request.urlopen(request, timeout=30).read()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(raw)
    if hashlib.sha256(raw).hexdigest() != source['sha256']:
        raise ValueError('Source checksum mismatch: ' + str(path))
    return raw.decode('utf-8-sig')

def rebuild(configuration, codes, supplementary, display_names, cache):
    inputs = {name: obtain(source, cache) for name, source in configuration.items()}
    companies = {f"0x{entry['code']:04X}": entry['name']
                 for entry in sorted(json.loads(inputs['nordic-companies']), key=lambda e: e['code'], reverse=True)
                 if entry['code'] <= 0x114C}
    maps = {}
    maps['nordic-services'] = {int(entry['uuid'], 16): entry['name']
                              for entry in json.loads(inputs['nordic-services']) if len(entry['uuid']) == 4}
    for name in ['swift-services', 'swift-members']:
        maps[name] = {entry['uuid']: entry['name'] for entry in json.loads(inputs[name])['uuids']}
    block = inputs['bluez-uuids'].split('} uuid16_table[] = {', 1)[1].split('\n};', 1)[0]
    maps['bluez-uuids'] = {int(code, 16): json.loads('"' + name + '"')
                          for code, name in re.findall(r'\{\s*0x([\da-fA-F]{4}),\s*"((?:[^"\\]|\\.)*)"', block)}
    services = {}
    provenance = {}
    # Resolve display names from the configured sources or the maintained supplement.
    priority = ['swift-services', 'swift-members', 'nordic-services', 'bluez-uuids']
    for code in codes:
        number = int(code, 16)
        source = next((name for name in priority if number in maps[name]), None)
        if source is None:
            if code not in supplementary:
                raise ValueError('Missing catalog entry: ' + code)
            services[code] = supplementary[code]
            provenance[code] = {'source': 'local-supplement', 'name': services[code]}
            continue
        name = maps[source][number]
        suffix = source in ['nordic-services', 'swift-services'] and not name.endswith('Service')
        label = display_names.get(code, name + ' Service' if suffix else name)
        services[code] = label
        provenance[code] = {'source': source, 'name': name, 'append_service': suffix}
        if code in display_names:
            provenance[code]['display_name'] = display_names[code]
    evidence = {
        'schema': 1,
        'sources': configuration,
        'company_selection': {'source': 'nordic-companies', 'maximum_code': '0x114C', 'entries': len(companies)},
        'service_scope': 'Compatibility identifiers only; not a source of names',
        'services': provenance,
        'output_sha256': {
            'bluetooth-companies.json': hashlib.sha256(encoded(companies)).hexdigest(),
            'bluetooth-services.json': hashlib.sha256(encoded(services)).hexdigest(),
        },
    }
    return {'bluetooth-companies.json': companies, 'bluetooth-services.json': services,
            'bluetooth-catalog-provenance.json': evidence}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache', type=Path, default=ROOT/'tmp/catalog-sources')
    parser.add_argument('--output', type=Path, default=ROOT/'shared')
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    sources = json.loads((CONFIG/'bluetooth-sources.json').read_text())
    codes = json.loads((CONFIG/'service-codes.json').read_text())
    if len(codes) != len(set(codes)) or codes != sorted(codes, key=lambda code: int(code, 16)):
        raise ValueError('Compatibility scope must contain sorted, unique identifiers')
    supplementary = json.loads((CONFIG/'supplementary-services.json').read_text())
    display_names = json.loads((CONFIG/'service-display-names.json').read_text())
    outputs = rebuild(sources, codes, supplementary, display_names, args.cache)
    if not args.check:
        args.output.mkdir(parents=True, exist_ok=True)
    for filename, value in outputs.items():
        raw = encoded(value)
        path = args.output/filename
        if args.check:
            if path.read_bytes() != raw:
                raise ValueError('Catalog does not match its declared inputs: ' + str(path))
        else:
            path.write_bytes(raw)
    evidence = outputs['bluetooth-catalog-provenance.json']
    print(f"companies={len(outputs['bluetooth-companies.json'])}; services={len(codes)}; local_supplements={sum(v['source'] == 'local-supplement' for v in evidence['services'].values())}")

if __name__ == '__main__':
    main()
