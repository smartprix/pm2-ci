const spawn = require('child_process').spawn;
const parse = require('url').parse;
const logger = require('./logger');

/**
 * Executes the callback, but in case of success shows a message.
 * Also accepts extra arguments to pass to logger.
 *
 * Example:
 * logCallback(next, '% worked perfect', appName)
 *
 * @param {Function} cb The callback to be called
 * @param {string} message The message to show if success
 * @returns {Function} The callback wrapped
 */
function logCallback(cb, ...args) {
	return function (err) {
		if (err) return cb(err);
		logger.log(...args);
		return cb();
	};
}

/**
 * Given a request, returns the name of the target App.
 *
 * Example:
 * Call to 34.23.34.54:3000/api-2
 * Will return 'api-2'
 *
 * @param req The request to be analysed
 * @returns {string|null} The name of the app, or null if not found.
 */
function reqToAppName(req) {
	let targetName = null;
	try {
		targetName = parse(req.url).pathname.split('/').pop();
	}
	catch (e) { logger.error(e) }
	return targetName || null;
}

/**
 * Wraps the node spawn function to work as exec (line, options, callback).
 * This avoid the maxBuffer issue, as no buffer will be stored.
 *
 * @param {string} command The line to execute
 * @param {object} options The options to pass to spawn
 * @param {function} cb The callback, called with error as first argument
 */
function spawnAsExec(command, options, cb) {
	const child = spawn('eval', [command], options);

	child.on('close', () => {
		cb();
	});

	child.stderr.on('data', (data) => {
		logger.error('Hook command error : %s', data.toString());
	});

	child.stdout.on('data', (data) => {
		logger.write(`Hook command log : ${data.toString()}`);
	});

	return child;
}


module.exports = {
	logCallback,
	reqToAppName,
	spawnAsExec,
};
