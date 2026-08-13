const bcrypt = require('bcrypt');
const password = process.argv[2];
if (!password) {
  console.error('Usage: node scripts/hashAdminPassword.js "TonMotDePasse"');
  process.exit(1);
}
bcrypt.hash(password, 10).then((hash) => console.log(hash));