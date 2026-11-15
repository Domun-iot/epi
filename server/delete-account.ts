import { existsSync } from 'node:fs';
import config from '#config';
import { openStore } from './store.ts';

const [email, confirmation, ...extra] = process.argv.slice(2);
if (!email || !email.includes('@') || email !== confirmation || extra.length) {
  throw new Error('Indiquer deux fois l’adresse e-mail exacte du compte à supprimer.');
}
if (!existsSync(config.path)) throw new Error('Base de production introuvable.');
const store = openStore(config.path);
try {
  const account = store.findAccount(email.trim().toLowerCase());
  if (!account) throw new Error('Compte introuvable.');
  store.deleteAccount(account.id);
  console.log('Le compte et ses données synchronisées ont été supprimés de la base active.');
} finally {
  store.close();
}
