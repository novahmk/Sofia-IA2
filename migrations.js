/**
 * migrations.js
 * Facade para manter compatibilidade com o boot atual.
 * A implementacao principal agora vive em migrations/run.js.
 */

require('dotenv').config();

const { runMigrations } = require('./migrations/run');

if (require.main === module) {
  runMigrations().catch((err) => {
    console.error(`❌ Erro nas migrations: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { runMigrations };
