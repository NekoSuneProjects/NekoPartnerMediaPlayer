module.exports = (sequelize, DataTypes) => {
  const Playlist = sequelize.define('Playlist', {
    name: DataTypes.STRING,
    cover: DataTypes.STRING
  });

  Playlist.associate = models => {
    Playlist.hasMany(models.Song, {
      foreignKey: 'playlistId',
      as: 'Songs',
      onDelete: 'CASCADE' // optional: delete songs when playlist is deleted
    });
  };

  return Playlist;
};
