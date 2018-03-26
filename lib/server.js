const zlib = require('zlib');
const path = require('path');
const fse = require('fs-extra');
const Koa = require('koa');
const staticCache = require('koa-static-cache');
const compress = require('koa-compress');
const renderer = require('koa-hbs-renderer');

const {getDb} = require('./db');
const hbs = require('./handlebars');
const logger = require('./logger');

let worker;
const app = new Koa();

app.use(compress({
	threshold: 2048,
	flush: zlib.Z_SYNC_FLUSH,
}));

app.use(staticCache(path.join(__dirname, './../templates/assets'), {
	maxAge: 30 * 24 * 60 * 60,			// 1 year (max-age in seconds)
	preload: false,						// don't cache file at start
	prefix: '/assets',					// path to serve at
	dynamic: true,						// load extra files if they exist
}));

app.use(renderer(hbs.options));

// Basic parser
app.use(async (ctx, next) => {
	try {
		if (ctx.request.method === 'GET') ctx.state.get = true;
		else if (ctx.request.method === 'POST') ctx.state.post = true;
		const urlPath = ctx.request.URL.pathname ? ctx.request.URL.pathname.split('/') : [];

		ctx.state.apps = Object.keys(worker.apps);
		ctx.state.appName = urlPath.length > 1 ? urlPath[1] : undefined;
		ctx.state.app = worker.apps[ctx.state.appName];
		if (urlPath.length === 3 && /[a-f0-9]{40}/.test(urlPath[2])) {
			ctx.state.commit = urlPath[2];
		}
		await next();
	}
	catch (e) { logger.error('[Server] Error: %s', e) }
});

// Serve commit reports
app.use(async (ctx, next) => {
	if (ctx.state.get &&
		ctx.state.app &&
		ctx.state.commit
	) {
		const filePath = `${worker.opts.dataDir}/test-reports/` +
			`${ctx.state.appName}/${ctx.state.commit}/${ctx.state.appName}.html`;

		try {
			await fse.stat(filePath);
		}
		catch (e) {
			ctx.status = 404;
			ctx.state.msg = `Commit, ${ctx.state.commit}, report not found!`;
			await ctx.render('testListing', ctx.state);
			return;
		}
		ctx.set('Content-type', 'text/html');
		ctx.body = fse.createReadStream(filePath);
		return;
	}
	await next();
});

// Manually start hook
app.use(async (ctx, next) => {
	if (ctx.state.get &&
		ctx.state.appName &&
		ctx.query.secret
	) {
		if (ctx.state.app && ctx.query.secret === ctx.state.app.secret) {
			worker.handleRequest(ctx, true, (ctx.query.deploy === 'on' && !ctx.query.commit));
			ctx.state.msg = 'Started Hook';
		}
		else if (!ctx.state.app) {
			ctx.state.msg = `App ${ctx.state.appName} doesn't exist in config`;
		}
		else ctx.state.msg = 'Wrong Secret';
		await ctx.render('testListing', ctx.state);
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
		else {
			const db = await getDb('tests');
			const perPage = 15;
			ctx.state.page = ctx.query.page ? Math.max(Number.parseInt(ctx.query.page, 10), 1) : 1;
			if (ctx.state.page > 1) ctx.state.prevPage = ctx.state.page - 1;
			ctx.state.nextPage = ctx.state.page + 1;

			const data = await new Promise((resolve, reject) => {
				db.db
					.find({app: ctx.state.appName, commit: {$exists: true}, data: {$exists: true}})
					.sort({'data.commit.time': -1})
					.skip((ctx.state.page - 1) * perPage)
					.limit(perPage)
					.exec((err, docs) => {
						if (err) reject(err);
						else resolve(docs);
					});
			});
			ctx.state.db = data;
			ctx.state.msg = 'Nothing Here.';
			await ctx.render('testListing', {...ctx.state, query: ctx.query, path: ctx.request.URL.pathname});
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

app.on('error', (err => logger.error('[Server] Error: %s', err)));

module.exports = function (req, res) {
	worker = this;
	return app.callback()(req, res);
};
