const fs = require('fs');
const path = require('path');
const Sequelize = require('sequelize');
const basename = path.basename(__filename);
const db = {};

// ✅ Instantiate Sequelize
let sequelize;

switch (process.env.DB_TYPE) {
  case 'mysql':
    sequelize = new Sequelize(process.env.DB_NAME, process.env.DB_USER, process.env.DB_PASS, {
      host: process.env.DB_HOST,
      port: process.env.DB_PORT || 3306,
      dialect: 'mysql',
      logging: false
    });
    break;
  case 'mariadb':
    sequelize = new Sequelize(process.env.DB_NAME, process.env.DB_USER, process.env.DB_PASS, {
      host: process.env.DB_HOST,
      port: process.env.DB_PORT || 3306,
      dialect: 'mariadb',
      logging: false
    });
    break;

  case 'postgres':
  case 'postgresql':
    sequelize = new Sequelize(process.env.DB_NAME, process.env.DB_USER, process.env.DB_PASS, {
      host: process.env.DB_HOST,
      port: process.env.DB_PORT || 5432,
      dialect: 'postgres',
      logging: false
    });
    break;

  case 'sqlite':
  default:
    sequelize = new Sequelize({
      dialect: 'sqlite',
      storage: process.env.SQLITE_STORAGE || './db.sqlite',
      logging: false
    });
    break;
}

// ✅ Import and initialize all models
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

// ✅ Set up associations if they exist
Object.keys(db).forEach(modelName => {
  if (db[modelName].associate) {
    db[modelName].associate(db);
  }
});

// ✅ Export the initialized Sequelize instance and models
db.sequelize = sequelize;
db.Sequelize = Sequelize;

module.exports = db;
