// Migration: Creates the account table and seeds the single admin row (ID = 1).
// account is the billing/ownership unit for the hosted, multi-tenant version of s33k.
// The seeded admin row is the home for all legacy single-tenant data: a NULL owner_id
// on domain/keyword is treated as equivalent to owner_id = 1 by the scoping helper, so
// existing rows keep working with zero data migration.
//
// This file supports both the Umzug v3 calling convention used by the app at
// /api/dbmigrate (the migration function is called with a single { context } object,
// where context is the Sequelize QueryInterface) and the classic sequelize-cli
// convention (the function is called with positional (queryInterface, Sequelize)). We
// normalise both into a queryInterface plus a DataTypes reference.

const { DataTypes } = require('sequelize');

// Resolve the QueryInterface regardless of which convention called the migration.
const resolveQueryInterface = (arg) => {
   if (arg && arg.context) { return arg.context; }
   return arg;
};

module.exports = {
   up: async (arg) => {
      const queryInterface = resolveQueryInterface(arg);
      return queryInterface.sequelize.transaction(async (t) => {
         try {
            // Idempotent: only create the table if it does not already exist.
            let exists = false;
            try {
               await queryInterface.describeTable('account');
               exists = true;
            } catch (describeError) {
               exists = false;
            }
            if (!exists) {
               await queryInterface.createTable('account', {
                  ID: {
                     type: DataTypes.INTEGER,
                     allowNull: false,
                     primaryKey: true,
                     autoIncrement: true,
                  },
                  name: {
                     type: DataTypes.STRING,
                     allowNull: true,
                     defaultValue: '',
                  },
                  plan: {
                     type: DataTypes.STRING,
                     allowNull: true,
                     defaultValue: 'free',
                  },
                  status: {
                     type: DataTypes.STRING,
                     allowNull: true,
                     defaultValue: 'active',
                  },
                  createdAt: {
                     type: DataTypes.DATE,
                     allowNull: true,
                  },
                  updatedAt: {
                     type: DataTypes.DATE,
                     allowNull: true,
                  },
               }, { transaction: t });
            }

            // Seed the single admin account (ID = 1) if it does not already exist.
            const [adminRows] = await queryInterface.sequelize.query(
               'SELECT ID FROM account WHERE ID = 1',
               { transaction: t },
            );
            if (!adminRows || adminRows.length === 0) {
               const now = new Date().toISOString();
               await queryInterface.sequelize.query(
                  'INSERT INTO account (ID, name, plan, status, createdAt, updatedAt) '
                  + 'VALUES (1, :name, :plan, :status, :createdAt, :updatedAt)',
                  {
                     replacements: {
                        name: 'Admin', plan: 'admin', status: 'active', createdAt: now, updatedAt: now,
                     },
                     transaction: t,
                  },
               );
            }
         } catch (error) {
            console.log('error :', error);
         }
      });
   },
   down: async (arg) => {
      const queryInterface = resolveQueryInterface(arg);
      return queryInterface.sequelize.transaction(async (t) => {
         try {
            let exists = false;
            try {
               await queryInterface.describeTable('account');
               exists = true;
            } catch (describeError) {
               exists = false;
            }
            if (exists) {
               await queryInterface.dropTable('account', { transaction: t });
            }
         } catch (error) {
            console.log('error :', error);
         }
      });
   },
};
