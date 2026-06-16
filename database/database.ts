import { Sequelize } from 'sequelize-typescript';
import sqlite3 from 'sqlite3';
import pg from 'pg';
import Domain from './models/domain';
import Keyword from './models/keyword';
import CrawlerHit from './models/crawlerHit';
import Account from './models/account';
import ApiKey from './models/apiKey';

const models = [Domain, Keyword, CrawlerHit, Account, ApiKey];
const pool = { max: 5, min: 0, idle: 10000 };

// Use Postgres when DATABASE_URL is set (hosted deploy), otherwise SQLite (local dev).
const connection = process.env.DATABASE_URL
   ? new Sequelize(process.env.DATABASE_URL, {
      dialect: 'postgres',
      dialectModule: pg,
      pool,
      logging: false,
      models,
   })
   : new Sequelize({
      dialect: 'sqlite',
      dialectModule: sqlite3,
      pool,
      logging: false,
      models,
      storage: process.env.DATABASE_PATH || './data/database.sqlite',
   });

export default connection;
