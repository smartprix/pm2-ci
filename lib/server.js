const zlib = require('zlib');
const fse = require('fs-extra');
const Koa = require('koa');
const renderer = require('koa-hbs-renderer');

const {getDb} = require('./db');
const hbs = require('./handlebars');
const logger = require('./logger');

let worker;
const app = new Koa();

app.use(renderer(hbs.options));

// Basic parser
app.use(async (ctx, next) => {
	try {
		if (ctx.request.method === 'GET') ctx.state.get = true;
		else if (ctx.request.method === 'POST') ctx.state.post = true;

		ctx.state.apps = Object.keys(worker.apps);
		const urlPath = ctx.request.URL.pathname.split('/');
		ctx.state.appName = urlPath.length > 1 ? urlPath[1] : undefined;
		ctx.state.app = worker.apps[ctx.state.appName];
		if (urlPath.length === 3 && /[a-f0-9]{40}/.test(urlPath[2])) {
			ctx.state.commit = urlPath[2];
		}
		await next();
	}
	catch (e) { logger.error(e) }
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
		return;
	}
	await next();
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
			worker.handleRequest(ctx, true);
		}
		else ctx.body = 'Wrong Secret';
		return;
	}
	await next();
});

// Serve directory listing
app.use(async (ctx, next) => {
	if (ctx.state.get &&
		!ctx.state.commit
	) {
		if (!ctx.state.appName) {
			await ctx.render('appListing', ctx.state);
		}
		else if (ctx.state.appName === 'assets') {
			ctx.body = fse.createReadStream(`${__dirname}/../templates/assets/${ctx.request.URL.pathname.split('/')[2]}`);
		}
		else {
			const db = await getDb('tests');
			const query = {};
			query[ctx.state.appName] = {$exists: true};
			ctx.state.db = await db.find(query, true);
			await ctx.render('testListing', ctx.state);
		}
		return;
	}
	await next();
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
		return;
	}
	await next();
});

app.use(async (ctx) => {
	ctx.body = 'N/A';
});

module.exports = function (req, res) {
	worker = this;
	return app.callback()(req, res);
};
