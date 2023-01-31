require('dotenv').config();
const mongoose = require('mongoose');
const logger = require('./logger').mkLogger('bizi-dns');
const util = require('util');
const dbhost = process.env.DB_ADDR || "127.0.0.1",
    dbport = process.env.DB_PORT || 27017,
    dbname = new String(process.env.DB_NAME || "/feta/db").replace(/\//g, ""),
    dbuser = encodeURIComponent(process.env.DB_USER),
    dbpass = encodeURIComponent(process.env.DB_PASS);
const dsn = util.format("mongodb://%s:%s@%s:%s/%s", dbuser, dbpass, dbhost, dbport, dbname);
logger.info("Mongo DSN:", dsn);
const options = { ssl: Boolean(process.env.DB_SSL), sslValidate: Boolean(process.env.DB_SSL_VALIDATE), authSource: process.env.DB_AUTH_SOURCE || process.env.DB_NAME }/* , { ssl: true, sslValidate: false } */
logger.info("Mongo options:", options);
mongoose.connect(dsn, options)
    .then(async cnx => {
        logger.sub('mongoose')
            .debug("Mongoose connection:", cnx);
        logger.info("Connected to database");
        if (!process.env.NO_START) {

            const app = require('./app');
            await app(Promise.resolve(mongoose.connection.getClient()));
        }
        logger.info("App setup complete");
    })
    .catch(err => {
        logger.sub('mongoose')
            .fatal("Unable to connect to database:", err);
        process.exit(1);
    })