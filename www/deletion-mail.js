import { randomUUID } from 'node:crypto';
import { rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const isMailbox = value => typeof value === 'string' && value.length <= 254 &&
  /^[a-z0-9.!#$%&'*+/=?^_\x60{|}~-]+@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(value) &&
  !/[\r\n]/.test(value) && value.indexOf('@') <= 64;

export async function readAccountEmail(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 1024) {
      req.resume();
      return null;
    }
    chunks.push(chunk);
  }
  const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  const addresses = form.getAll('email');
  return addresses.length === 1 && isMailbox(addresses[0]) ? addresses[0] : null;
}

export async function saveDeletionMail(directory, contact, email, locale) {
  const id = randomUUID();
  const now = new Date();
  const filename = 'epi-deletion-' + now.toISOString().replace(/[:.]/g, '-') + '-' + id;
  const temporary = join(directory, '.' + filename + '.tmp');
  const subject = Buffer.from('Suppression de compte éPI').toString('base64');
  const body = Buffer.from(
    'Demande de suppression de compte reçue via le formulaire du site éPI.\r\n' +
    'Adresse déclarée du compte (à vérifier) : ' + email + '\r\n' +
    'Langue : ' + locale + '\r\n',
  ).toString('base64').match(/.{1,76}/g);
  const message = [
    'From: ' + contact,
    'To: ' + contact,
    'Reply-To: ' + email,
    'Date: ' + now.toUTCString().replace('GMT', '+0000'),
    'Message-ID: <' + id + '@' + contact.split('@')[1] + '>',
    'Subject: =?UTF-8?B?' + subject + '?=',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '', ...body, '',
  ].join('\r\n');

  try {
    await writeFile(temporary, message, { flag: 'wx', mode: 0o600, flush: true });
    await rename(temporary, join(directory, filename + '.eml'));
  } catch (error) {
    if (error.code !== 'EEXIST') await unlink(temporary).catch(() => {});
    throw error;
  }
}
