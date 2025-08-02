module.exports = (sequelize, DataTypes) => {
  const Song = sequelize.define('Song', {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true
    },
    Artist: DataTypes.STRING,
    title: DataTypes.STRING,
    cover: DataTypes.STRING,
    youtubeid: DataTypes.STRING,
    views: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0
    },
    likes: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0
    },
    playlistId: {
      type: DataTypes.INTEGER,
      allowNull: false
    }
  });

  Song.associate = models => {
    Song.belongsTo(models.Playlist, {
      foreignKey: 'playlistId',
      as: 'Playlist'
    });
  };

  return Song;
};
