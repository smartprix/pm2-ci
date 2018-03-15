const path = require('path');
const url = require('url');
const zlib = require('zlib');
const fse = require('fs-extra');

const logger = require('./logger');

/**
 * Main function for http server
 *
 * @param req The Request
 * @param res The Response
 * @private
 */
module.exports = function (req, res) {
	// get request => serve test report if exists
	if (req.method === 'GET') {
		const parsedUrl = url.parse(req.url, true);
		const urlPath = parsedUrl.pathname;
		const appName = urlPath.split('/')[1];
		const appConf = this.apps[appName];
		let commit;

		// matches /APP_NAME/COMMIT_HASH
		if (/^\/[a-zA-Z0-9-_]+\/[a-f0-9]{40}\/?$/.test(urlPath)) {
			commit = urlPath.split('/')[2];
		}
		// matches '/APP_NAME/'
		else if (/^\/[a-zA-Z0-9-_]+\/?$/.test(urlPath)) {
			commit = appConf && appConf.tests.lastGoodCommit;
			if (appConf && parsedUrl.query.secret === appConf.secret) {
				this.processRequest(req, false);
				res.end('started hook');
				return;
			}
			else if (!commit) {
				res.statusCode = 404;
				if (appConf) res.end('No test reports exist for this app');
				else res.end('No such app');
				return;
			}
		}
		else {
			res.writeHead(200, {'Content-Type': 'text/plain'});
			res.end('N/A');
		}

		let filePath = `${this.opts.logsDir}/test-reports/`;
		if (appName && commit && appConf) {
			filePath += `${appName}/${commit}/${appConf.tests.reportPath.split('/')[1]}.html`;
			logger.log(`Serving test report for commit ${commit} of ${appName}`);
		}
		else {
			res.statusCode = 404;
			res.end('No such app');
			return;
		}

		const ext = path.parse(filePath).ext;
		const map = {
			'.ico': 'image/x-icon',
			'.html': 'text/html',
			'.js': 'text/javascript',
			'.json': 'application/json',
			'.css': 'text/css',
			'.png': 'image/png',
			'.jpg': 'image/jpeg',
		};

		fse.exists(filePath, (exist) => {
			if (!exist) {
				// if the file is not found, return 404
				res.statusCode = 404;
				res.end(`File ${filePath} not found!`);
				return;
			}

			// read file from file system
			let raw;
			try {
				raw = fse.createReadStream(filePath);
			}
			catch (err) {
				res.statusCode = 500;
				res.end(`Error getting the file: ${err}.`);
				return;
			}

			const acceptEncoding = req.headers['accept-encoding'] || '';
			res.setHeader('Content-type', map[ext] || 'text/plain');

			if (/\bdeflate\b/.test(acceptEncoding)) {
				res.writeHead(200, {'Content-Encoding': 'deflate'});
				raw.pipe(zlib.createDeflate()).pipe(res);
			}
			else if (/\bgzip\b/.test(acceptEncoding)) {
				res.writeHead(200, {'Content-Encoding': 'gzip'});
				raw.pipe(zlib.createGzip()).pipe(res);
			}
			else {
				res.writeHead(200, {});
				raw.pipe(res);
			}
		});
	}
	// post request => webhook
	else if (req.method === 'POST') {
		// send instant answer since its useless to respond to the webhook
		res.writeHead(200, {'Content-Type': 'text/plain'});
		res.write('OK');

		// get source ip
		req.ip = req.headers['x-forwarded-for'] ||
		(req.connection ? req.connection.remoteAddress : false) ||
		(req.socket ? req.socket.remoteAddress : false) ||
		((req.connection && req.connection.socket) ? req.connection.socket.remoteAddress : false) || '';

		if (req.ip.indexOf('::ffff:') !== -1) {
			req.ip = req.ip.replace('::ffff:', '');
		}

		// get the whole body before processing
		req.body = '';
		req.on('data', (data) => {
			req.body += data;
		}).on('end', () => {
			this.processRequest(req);
		});
		res.end();
	}
	else {
		res.writeHead(200, {'Content-Type': 'text/plain'});
		res.end('N/A');
	}
};
