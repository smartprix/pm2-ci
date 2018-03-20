const Datastore = require('nedb');

let dir = '/home/smpx-170l/projects/pm2-githook';

class DB {
	constructor(name) {
		this.db = new Datastore({filename: `${dir}/${name}.db`});
		this.initialized = false;
		return this;
	}

	async init() {
		if (this.initialized) return this;
		return new Promise((resolve, reject) => {
			this.db.loadDatabase((err) => {
				if (err) reject(err);
				else {
					this.initialized = true;
					resolve(this);
				}
			});
		});
	}

	/**
	 * Insert one or more documents
	 * @param {Object|Array<Object>} doc
	 * @returns {Object|Array<Object>} Inserted documents
	 */
	async insert(doc) {
		return new Promise((resolve, reject) => {
			this.db.insert(doc, (err, newDoc) => {
				if (err) reject(err);
				else resolve(newDoc);
			});
		});
	}

	/**
	 * Find docs in DB
	 * @param {Object} query Query object
	 * @param {boolean} one findOne or all
	 * @returns {Object|Array<Object>} Matched documents
	 */
	async find(query, one = false) {
		return new Promise((resolve, reject) => {
			if (one) {
				this.db.findOne(query, (err, doc) => {
					if (err) reject(err);
					else resolve(doc);
				});
			}
			else {
				this.db.find(query, (err, docs) => {
					if (err) reject(err);
					else resolve(docs);
				});
			}
		});
	}

	/**
	 * Find docs in DB and return only selected fields
	 * @param {Object} query Query object
	 * @param {Object} projection Projection object to select what to return
	 * @param {boolean} one findOne or all
	 * @returns {Object|Array<Object>} Matched documents
	 */
	async select(query, projection, one = false) {
		return new Promise((resolve, reject) => {
			if (one) {
				this.db.findOne(query, projection, (err, doc) => {
					if (err) reject(err);
					else resolve(doc);
				});
			}
			else {
				this.db.find(query, projection, (err, docs) => {
					if (err) reject(err);
					else resolve(docs);
				});
			}
		});
	}

	/**
	 * Update documents
	 * @param {Object} query Query Object
	 * @param {Object} doc Updated data or Object with modifiers like $set
	 * @param {boolean} upsert
	 * @param {boolean} allThatMatch
	 * @returns {Object|Array<Object>} updatedDocs
	 */
	async update(query, doc, upsert = false, allThatMatch = false) {
		return new Promise((resolve, reject) => {
			this.db.update(query, doc, {
				upsert,
				returnUpdatedDocs: true,
				multi: allThatMatch,
			}, (err, n, updatedDocs) => {
				if (err) reject(err);
				else resolve(updatedDocs);
			});
		});
	}

	/**
	 * Delete docs
	 * @param {Object} query Query Object
	 * @param {boolean} allThatMatch
	 * @returns {number} Number of docs deleted
	 */
	async delete(query, allThatMatch = false) {
		return new Promise((resolve, reject) => {
			this.db.remove(query, {multi: allThatMatch}, (err, n) => {
				if (err) reject(err);
				else resolve(n);
			});
		});
	}

	async compact() {
		return new Promise((resolve, reject) => {
			try {
				this.db.persistence.compactDatafile();
				this.db.on('compaction.done', resolve);
			}
			catch (e) {
				reject(e);
			}
		});
	}
}

const dbs = {};

/**
 * Get a db with name
 * @param {string} name
 * @returns {DB} DB object
 */
async function getDb(name) {
	if (name in dbs) return dbs[name];
	dbs[name] = new DB(name);
	await dbs[name].init();
	return dbs[name];
}

module.exports = {
	getDb,
	setPath: (path) => {
		dir = path;
	},
};
