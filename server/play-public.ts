import { readFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';

const escape = (value: string) => value.replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character] ?? character));

export function playPublicPages(file: string) {
  let config;
  try {
    config = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/u, ''));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const { publisher, contact, retention } = config ?? {};
  if (typeof publisher !== 'string' || !publisher.trim() ||
      typeof contact !== 'string' || !/^[\w.+-]+@[\w.-]+\.[a-z]{2,}$/i.test(contact) ||
      typeof retention !== 'string' || !retention.trim()) {
    throw new Error('Renseigner publisher, contact et retention dans play-public.json.');
  }

  const email = escape(contact);
  const deletion = '<h1>Supprimer un compte éPI</h1>' +
    '<p>Pour demander la suppression de votre compte et des données synchronisées, envoyez un message depuis l’adresse associée au compte. Le support peut vous demander de confirmer votre demande. Ne communiquez jamais votre mot de passe.</p>' +
    '<p><a href="mailto:' + email + '?subject=Suppression%20de%20compte%20%C3%A9PI">Envoyer une demande à ' + email + '</a></p>' +
    '<p>La suppression retire le compte, les accès de vos appareils et les données synchronisées du serveur actif. Pour supprimer vos copies locales et vos exports, effacez-les sur chaque appareil concerné.</p>' +
    '<h2>Délais et conservation</h2><p>' + escape(retention) + '</p>' +
    '<p><a href="/confidentialite">Politique de confidentialité</a></p>';
  const privacy = '<h1>Confidentialité de l’application éPI</h1>' +
    '<p>Éditeur et contact pour les données personnelles : ' + escape(publisher) + ' – <a href="mailto:' + email + '">' + email + '</a>.</p>' +
    '<h2>Utilisation sur l’appareil</h2><p>éPI utilise le Bluetooth pour recevoir les mesures des balances compatibles. L’application enregistre sur l’appareil les profils, les balances et les pesées, dont le poids et, selon le profil et la balance, les estimations de composition corporelle. Vous pouvez exporter vos données dans un fichier que vous gérez vous-même.</p>' +
    '<h2>Compte et synchronisation</h2><p>La création d’un compte et la connexion sont facultatives. Pour gérer l’accès et synchroniser les données, éPI transmet à son serveur via HTTPS l’adresse e-mail, les données d’authentification, les identifiants d’appareil ainsi que les données synchronisées de profils, de balances et de pesées. Pour un compte avec mot de passe, le serveur conserve une empreinte du mot de passe. Si vous choisissez la connexion Google, le service d’authentification Google fournit à éPI votre adresse e-mail, un identifiant Google et, si disponible, votre langue.</p>' +
    '<h2>Accès, conservation et suppression</h2><p>' + escape(retention) + '</p>' +
    '<p>Pour exercer vos droits relatifs à vos données, écrivez à l’adresse de contact ci-dessus. Pour supprimer votre compte, utilisez <a href="/supprimer-compte">la page de demande de suppression</a>.</p>';
  const pages = new Map([
    ['/confidentialite', { title: 'Confidentialité', body: privacy }],
    ['/supprimer-compte', { title: 'Supprimer un compte', body: deletion }],
  ]);
  return (path: string, res: ServerResponse) => {
    const page = pages.get(path);
    if (!page) return false;
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
      'X-Content-Type-Options': 'nosniff',
    });
    res.end('<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>' +
      page.title + ' | éPI</title><main>' + page.body + '</main></html>');
    return true;
  };
}
