const crypto = require('crypto');

const getKey = () => {
  const secret = process.env.DOMAIN_DKIM_ENCRYPTION_SECRET || process.env.PASSWORD_ENCRYPTION_SECRET;
  if (!secret) throw new Error('Configure DOMAIN_DKIM_ENCRYPTION_SECRET before managing sender domains.');
  return crypto.scryptSync(secret, 'adms-sender-domain-dkim-v1', 32);
};

const encrypt = (plaintext) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join(':');
};

const decrypt = (value) => {
  const [version, encodedIv, encodedTag, encodedCiphertext] = String(value || '').split(':');
  if (version !== 'v1' || !encodedIv || !encodedTag || !encodedCiphertext) throw new Error('Stored DKIM key has an unsupported format.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(encodedIv, 'base64'));
  decipher.setAuthTag(Buffer.from(encodedTag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(encodedCiphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
};

module.exports = { encrypt, decrypt };