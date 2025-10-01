module.exports = (sequelize, DataTypes) => {
  const Playlist = sequelize.define('Playlist', {
    name: DataTypes.STRING,
    cover: DataTypes.STRING,
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false
    }
  });

  Playlist.associate = models => {
    // Playlist belongs to one user
    Playlist.belongsTo(models.User, {
      foreignKey: 'userId',
      as: 'Owner'
    });

    // Playlist has many songs
    Playlist.hasMany(models.Song, {
      foreignKey: 'playlistId',
      as: 'Songs',
      onDelete: 'CASCADE'
    });
  };

  return Playlist;
};
