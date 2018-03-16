const zlib = require('zlib');
const fse = require('fs-extra');
const Koa = require('koa');
const serveList = require('koa-serve-list');

const logger = require('./logger');

let worker;
const app = new Koa();

// Basic parser
app.use(async (ctx, next) => {
	if (ctx.request.method === 'GET') ctx.state.get = true;
	else if (ctx.request.method === 'POST') ctx.state.post = true;

	const urlPath = ctx.request.URL.pathname.split('/');
	ctx.state.appName = urlPath[1];
	ctx.state.app = worker.apps[ctx.state.appName];
	if (urlPath.length === 3 && /[a-f0-9]{40}/.test(urlPath[2])) {
		ctx.state.commit = urlPath[2];
	}
	return next();
});

// Serve commit reports
app.use(async (ctx, next) => {
	if (ctx.state.get &&
		ctx.state.app &&
		ctx.state.commit
	) {
		const filePath = `${worker.opts.logsDir}/test-reports/` +
			`${ctx.state.appName}/${ctx.state.commit}/${ctx.state.app.tests.reportPath.split('/')[1]}.html`;

		const exist = await fse.exists(filePath);
		if (!exist) {
			ctx.status = 404;
			ctx.body = `Commit, ${ctx.state.commit}, report not found!`;
			return;
		}
		const raw = fse.createReadStream(filePath);
		const acceptEncoding = ctx.get('accept-encoding');

		ctx.set('Content-type', 'text/html');

		if (/\bdeflate\b/.test(acceptEncoding)) {
			ctx.set('Content-Encoding', 'deflate');
			ctx.body = raw.pipe(zlib.createDeflate());
		}
		else if (/\bgzip\b/.test(acceptEncoding)) {
			ctx.set('Content-Encoding', 'gzip');
			ctx.body = raw.pipe(zlib.createGzip());
		}
		else {
			ctx.body = raw;
		}
	}
	else next();
});

// Manually start hook
app.use(async (ctx, next) => {
	if (ctx.state.get &&
		ctx.state.app &&
		ctx.query.secret
	) {
		console.log('start hook');
		if (ctx.query.secret === ctx.state.app.secret) {
			ctx.body = 'Started Hook';
			worker.handleRequest(ctx, false);
		}
		else ctx.body = 'Wrong Secret';
	}
	else next();
});

// Serve directory listing
app.use(async (ctx, next) => {
	if (ctx.state.get &&
		!ctx.state.commit
	) {
		await serveList(`${worker.opts.logsDir}/test-reports/`)(ctx, next);
	}
	else next();
});

// Handle github webhook
app.use(async (ctx, next) => {
	if (ctx.state.post) {
		ctx.body = 'OK';

		// get the whole body before processing
		ctx.request.body = '';
		ctx.req.on('data', (data) => {
			ctx.request.body += data;
		}).on('end', () => {
			worker.handleRequest(ctx);
		});
	}
	else next();
});

app.use(async (ctx) => {
	ctx.body = 'N/A';
});

app.on('error', (err) => {
	logger.error('server error', err);
});

module.exports = function (req, res) {
	worker = this;
	return app.callback()(req, res);
};
