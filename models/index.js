const fs = require('fs');
const path = require('path');
const Sequelize = require('sequelize');
const basename = path.basename(__filename);
const db = {};

// Instantiate Sequelize
let sequelize;

function numEnv(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}

function buildCommonOptions() {
  return {
    logging: false,
    pool: {
      max: numEnv('DB_POOL_MAX', 5),
      min: numEnv('DB_POOL_MIN', 0),
      acquire: numEnv('DB_POOL_ACQUIRE_MS', 30000),
      idle: numEnv('DB_POOL_IDLE_MS', 10000),
      evict: numEnv('DB_POOL_EVICT_MS', 1000),
    },
    retry: {
      max: numEnv('DB_SEQUELIZE_RETRY_MAX', 3),
      match: [
        /SequelizeConnectionError/i,
        /SequelizeConnectionRefusedError/i,
        /SequelizeHostNotFoundError/i,
        /SequelizeHostNotReachableError/i,
        /SequelizeInvalidConnectionError/i,
        /SequelizeConnectionTimedOutError/i,
        /ETIMEDOUT/i,
        /ECONNRESET/i,
        /EHOSTUNREACH/i,
        /ECONNREFUSED/i,
        /08S01/i,
      ],
    },
  };
}

switch (process.env.DB_TYPE) {
  case 'mysql':
    sequelize = new Sequelize(process.env.DB_NAME, process.env.DB_USER, process.env.DB_PASS, {
      host: process.env.DB_HOST,
      port: numEnv('DB_PORT', 3306),
      dialect: 'mysql',
      dialectOptions: {
        connectTimeout: numEnv('DB_CONNECT_TIMEOUT_MS', 10000),
      },
      ...buildCommonOptions(),
    });
    break;

  case 'mariadb':
    sequelize = new Sequelize(process.env.DB_NAME, process.env.DB_USER, process.env.DB_PASS, {
      host: process.env.DB_HOST,
      port: numEnv('DB_PORT', 3306),
      dialect: 'mariadb',
      dialectOptions: {
        connectTimeout: numEnv('DB_CONNECT_TIMEOUT_MS', 10000),
      },
      ...buildCommonOptions(),
    });
    break;

  case 'postgres':
  case 'postgresql':
    sequelize = new Sequelize(process.env.DB_NAME, process.env.DB_USER, process.env.DB_PASS, {
      host: process.env.DB_HOST,
      port: numEnv('DB_PORT', 5432),
      dialect: 'postgres',
      ...buildCommonOptions(),
    });
    break;

  case 'sqlite':
  default:
    sequelize = new Sequelize({
      dialect: 'sqlite',
      storage: process.env.SQLITE_STORAGE || './db.sqlite',
      ...buildCommonOptions(),
    });
    break;
}

// Import and initialize all models
fs.readdirSync(__dirname)
  .filter(file =>
    file !== basename &&
    file.endsWith('.js') &&
    !file.startsWith('.')
  )
  .forEach(file => {
    const model = require(path.join(__dirname, file))(sequelize, Sequelize.DataTypes);
    db[model.name] = model;
  });

// Set up associations if they exist
Object.keys(db).forEach(modelName => {
  if (db[modelName].associate) {
    db[modelName].associate(db);
  }
});

// Export the initialized Sequelize instance and models
db.sequelize = sequelize;
db.Sequelize = Sequelize;

module.exports = db;

