const mongoose = require('mongoose');

const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGODB_URI, {
      dbName: "wakanect",
    });

    console.log(`Modibo: MongoDB connecté : ${conn.connection.host}`);

    mongoose.connection.on('disconnected', () => {
      console.warn('Modibo: MongoDB déconnecté, tentative de reconnexion...')
    });

    mongoose.connection.on('error', (err){
      console.error('Modibo: Erreur MongoDB: ', err.message);
    });

  } catch (error){
    console.error("Modibo: ", error.message);
    process.exit(1)
  }
};

module.exports = connectDB;