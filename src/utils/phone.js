/**
 * Normalize a phone number to canonical form: digits only with country code.
 * WhatsApp Cloud API sends without '+', e.g. "221771234567".
 * This function aligns stored and queried numbers to that same form.
 *
 * "+221 77 123 45 67" → "221771234567"
 * "221 77 123 45 67"  → "221771234567"
 * "0022177123456"     → "221771234567"
 */
function normalizePhone(raw) {
  if (!raw) return '';
  let s = String(raw).trim();
  // Strip common formatting chars (spaces, dashes, dots, parentheses)
  s = s.replace(/[\s\-().]/g, '');
  // Strip leading +
  if (s.startsWith('+')) s = s.slice(1);
  // Strip international prefix 00
  if (s.startsWith('00')) s = s.slice(2);
  // Remove any remaining non-digit characters
  return s.replace(/\D/g, '');
}

module.exports = { normalizePhone };
