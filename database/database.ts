import { Sequelize } from 'sequelize-typescript';
import sqlite3 from 'sqlite3';
import Domain from './models/domain';
import Keyword from './models/keyword';
import CrawlerHit from './models/crawlerHit';
import Account from './models/account';
import ApiKey from './models/apiKey';

const connection = new Sequelize({
   dialect: 'sqlite',
   host: '0.0.0.0',
   username: process.env.USER_NAME ? process.env.USER_NAME : process.env.USER,
   password: process.env.PASSWORD,
   database: 'sequelize',
   dialectModule: sqlite3,
   pool: {
      max: 5,
      min: 0,
      idle: 10000,
   },
   logging: false,
   models: [Domain, Keyword, CrawlerHit, Account, ApiKey],
   storage: process.env.DATABASE_PATH || './data/database.sqlite',
});

export default connection;
