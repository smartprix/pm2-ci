/**
 * Copyright 2018 vmarchaud, rohit-smpx. All rights reserved.
 * Use of this source code is governed by a license that
 * can be found in the LICENSE file.
 */

const pmx = require('pmx');
const pm2 = require('pm2');

const Worker = require('./lib/Worker');
const slack = require('./lib/slack');
const logger = require('./lib/logger');
const db = require('./lib/db');

/**
 * Init pmx module
 */
pmx.initModule({}, (err, conf) => {
	logger.init(`${conf.dataDir}/logs`);
	slack.init(conf);
	db.setPath(`${conf.dataDir}/db`);

	process.on('uncaughtException', (error) => {
		logger.error('UncaughtException:', error.message);
		logger.error(error.stack);
		process.exit(1);
	});

	pm2.connect(async (err2) => {
		if (err || err2) {
			logger.error('Error: %s', JSON.stringify(err || err2));
			process.exit(1);
			return;
		}
		const apps = Object.keys(conf.apps);
		const tests = await db.getDb('tests');
		try {
			await tests.update(
				{apps: {$exists: true}},
				{$addToSet: {apps: {$each: apps}}},
				true
			);
		}
		catch (e) {
			await tests.insert({apps});
		}
		apps.map(app => db.convertOldDb(tests, app));
		await Promise.all(apps);
		await tests.compact();
		// init the worker only if we can connect to pm2
		const worker = new Worker(conf);
		try {
			await worker.start();
		}
		catch (err3) {
			logger.error(err3);
			process.exit(1);
		}
	});
});
