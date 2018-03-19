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
	if (typeof (conf.slack) !== 'object') {
		conf.slack = JSON.parse(conf.slack);
	}
	logger.init(`${conf.logsDir}/logs`);
	slack.init(conf.slack);
	db.setPath(`${conf.logsDir}/db`);

	pm2.connect(async (err2) => {
		if (err || err2) {
			logger.error('Error: %s', JSON.stringify(err || err2));
			process.exit(1);
			return;
		}
		const tests = await db.getDb('tests');
		try {
			await tests.update(
				{apps: {$exists: true}},
				{$addToSet: {apps: {$each: Object.keys(conf.apps)}}},
				true
			);
		}
		catch (e) {
			await tests.insert({apps: Object.keys(conf.apps)});
		}
		await tests.compact();

		// init the worker only if we can connect to pm2
		new Worker(conf).start();
	});
});

