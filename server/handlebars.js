const path = require('path');
const Handlebars = require('handlebars');

const hbs = Handlebars.create();

hbs.registerHelper('tests', (db) => {
	if (Array.isArray(db)) return db.map(doc => doc.data);
	return [];
});

hbs.registerHelper('join', (arr) => arr.join(', '));

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

