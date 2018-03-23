const path = require('path');
const Handlebars = require('handlebars');

const hbs = Handlebars.create();

hbs.registerHelper('tests', (db, appName, page = 1) => {
	const perPage = 15;
	if (page < 1) page = 1;
	if (db === null || db === undefined) return [];
	return Object.values(db[appName]).sort((a, b) => {
		if (a.commit.time === undefined && b.commit.time === undefined) return 0;
		if (a.commit.time === undefined) return 1;
		if (b.commit.time === undefined) return -1;
		if (a.commit.time > b.commit.time) return -1;
		if (a.commit.time < b.commit.time) return 1;
		return 0;
	}).slice((page - 1) * perPage, page * perPage);
});

hbs.registerHelper('pageLink', (pageNumber, query, pathname) => {
	query.page = pageNumber;
	const qs = Object.keys(query).map(key => `${key}=${query[key]}`).join('&');
	return `${pathname}?${qs}`;
});

module.exports = {
	options: {
		cacheExpires: 60,
		contentTag: 'content',
		extension: '.hbs',
		hbs,
		paths: {
			views: path.join(__dirname, '/../templates'),
		},
		Promise,
	},
};

