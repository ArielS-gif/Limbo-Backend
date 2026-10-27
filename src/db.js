// The database: a small stand-in for the parts of mongoose this backend uses, so it needs no database server.
// Records live in memory and each one is saved as its own JSON file under data/<collection>/.
// Collections with a TTL index (game sessions) only last seconds, so they stay in memory.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const kDataDir = path.join(__dirname, "..", "data");
const kTtlSweepMs = 60 * 1000; // as often as MongoDB's TTL monitor

const clone = (value) => structuredClone(value);
// Starts with the time like MongoDB's ObjectId, so records load back in the order they were made.
const newId = () => Math.floor(Date.now() / 1000).toString(16).padStart(8, "0") + crypto.randomBytes(8).toString("hex");

function getPath(object, dotted) {
    return dotted.split(".").reduce((value, key) => (value == null ? undefined : value[key]), object);
}

function setPath(object, dotted, value) {
    const keys = dotted.split(".");
    const last = keys.pop();
    let target = object;
    for (const key of keys) target = target[key] ??= {};
    target[last] = value;
}

function same(a, b) {
    if (a instanceof Date || b instanceof Date) return new Date(a).getTime() === new Date(b).getTime();
    if (a && b && typeof a === "object" && typeof b === "object") return JSON.stringify(a) === JSON.stringify(b);
    return a === b || (a == null && b == null);
}

// Like MongoDB, a condition on an array field matches when any element matches.
const anyElement = (value, test) => test(value) || (Array.isArray(value) && value.some(test));
const ordered = (test) => (value, arg) => anyElement(value, (v) => v != null && typeof v === typeof arg && test(v, arg));

const kOperators = {
    $eq: (value, arg) => anyElement(value, (v) => same(v, arg)),
    $ne: (value, arg) => !anyElement(value, (v) => same(v, arg)),
    $in: (value, arg) => arg.some((a) => anyElement(value, (v) => same(v, a))),
    $nin: (value, arg) => !arg.some((a) => anyElement(value, (v) => same(v, a))),
    $gt: ordered((v, arg) => v > arg),
    $gte: ordered((v, arg) => v >= arg),
    $lt: ordered((v, arg) => v < arg),
    $lte: ordered((v, arg) => v <= arg),
    $exists: (value, arg) => (value !== undefined) === Boolean(arg),
};

const isOperators = (condition) => condition !== null && typeof condition === "object" && !Array.isArray(condition)
    && !(condition instanceof Date) && Object.keys(condition).some((key) => key.startsWith("$"));

function matches(record, filter) {
    return Object.entries(filter).every(([key, condition]) => {
        if (key === "$or") return condition.some((sub) => matches(record, sub));
        if (key === "$and") return condition.every((sub) => matches(record, sub));
        if (key === "$nor") return !condition.some((sub) => matches(record, sub));

        const value = getPath(record, key);
        if (!isOperators(condition)) return kOperators.$eq(value, condition);

        return Object.entries(condition).every(([operator, arg]) => {
            if (!kOperators[operator]) throw new Error(`db: unsupported query operator ${operator}`);
            return kOperators[operator](value, arg);
        });
    });
}

function project(record, projection) {
    if (!projection || !Object.keys(projection).length) return record;
    const picked = { _id: record._id };
    for (const [key, include] of Object.entries(projection)) {
        if (include && record[key] !== undefined) picked[key] = record[key];
    }
    return picked;
}

function runHook(hook, document) {
    return new Promise((resolve, reject) => {
        const result = hook.call(document, (error) => (error ? reject(error) : resolve()));
        if (hook.length === 0) Promise.resolve(result).then(resolve, reject);
    });
}

function writeRecord(dir, record) {
    const file = path.join(dir, `${record._id}.json`);
    const json = JSON.stringify(record);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${file}.tmp`, json);
    try {
        fs.renameSync(`${file}.tmp`, file);
    } catch {
        // Windows can refuse the swap while something (like antivirus) has the old file open.
        fs.writeFileSync(file, json);
        fs.rmSync(`${file}.tmp`, { force: true });
    }
}

function readRecords(dir) {
    const records = new Map();
    if (!fs.existsSync(dir)) return records;

    for (const name of fs.readdirSync(dir).sort()) {
        const file = path.join(dir, name);
        if (name.endsWith(".tmp")) {
            fs.rmSync(file, { force: true }); // a save cut off half-way; the record before it is still there
            continue;
        }
        if (!name.endsWith(".json")) continue;

        try {
            const record = JSON.parse(fs.readFileSync(file, "utf8"));
            records.set(record._id, record);
        } catch (error) {
            console.error(`db: skipping ${file}: ${error.message}`);
        }
    }

    return records;
}

class Schema {
    constructor(definition, options = {}) {
        this.definition = definition;
        this.options = options;
        this.hooks = [];
        this.ttl = null;
    }

    index(fields, options = {}) {
        if (options.expireAfterSeconds !== undefined) {
            this.ttl = { field: Object.keys(fields)[0], seconds: options.expireAfterSeconds };
        }
    }

    pre(event, hook) {
        if (event !== "save") throw new Error(`db: only pre('save') hooks are supported, not '${event}'`);
        this.hooks.push(hook);
    }
}

class Query {
    constructor(model, filter, { one = false, projection } = {}) {
        this.model = model;
        this.filter = filter;
        this.one = one;
        this.projection = projection;
        this.isLean = false;
        this.max = 0;
    }

    lean() {
        this.isLean = true;
        return this;
    }

    limit(max) {
        this.max = max;
        return this;
    }

    async exec() {
        let found = this.model.matching(this.filter);
        if (this.one) found = found.slice(0, 1);
        else if (this.max) found = found.slice(0, this.max);

        const results = found.map((record) => (this.isLean ? project(clone(record), this.projection) : this.model.hydrate(record)));
        return this.one ? results[0] ?? null : results;
    }

    then(resolve, reject) {
        return this.exec().then(resolve, reject);
    }

    catch(reject) {
        return this.exec().catch(reject);
    }
}

function model(name, schema) {
    const collection = schema.options.collection || name;
    const dir = path.join(kDataDir, collection);
    const persist = !schema.ttl;
    const records = persist ? readRecords(dir) : new Map();

    const timestamps = schema.options.timestamps || {};
    const updatedAt = timestamps === true ? "updatedAt" : timestamps.updatedAt;
    const createdAt = timestamps === true ? "createdAt" : timestamps.createdAt;
    // Like mongoose's strict mode: only the schema's own fields are kept.
    const fields = ["_id", ...Object.keys(schema.definition), updatedAt, createdAt].filter(Boolean);

    function defaults() {
        const values = {};
        for (const [key, spec] of Object.entries(schema.definition)) {
            const type = spec && spec.type !== undefined ? spec.type : spec;
            if (spec && typeof spec === "object" && "default" in spec) {
                values[key] = clone(typeof spec.default === "function" ? spec.default() : spec.default);
            } else if (Array.isArray(type)) {
                values[key] = [];
            }
        }
        return values;
    }

    function store(record) {
        records.set(record._id, record);
        if (persist) writeRecord(dir, record);
    }

    function remove(id) {
        records.delete(id);
        if (persist) fs.rmSync(path.join(dir, `${id}.json`), { force: true });
    }

    class Model {
        constructor(data = {}) {
            Object.defineProperty(this, "isNew", { value: true, writable: true, enumerable: false });
            const values = { ...defaults(), ...clone(data) };
            for (const key of fields) {
                if (values[key] !== undefined) this[key] = values[key];
            }
            if (!this._id) this._id = newId();
        }

        static matching(filter = {}) {
            return [...records.values()].filter((record) => matches(record, filter));
        }

        static hydrate(record) {
            const document = new Model(record);
            document.isNew = false;
            return document;
        }

        static find(filter = {}, projection) {
            return new Query(Model, filter, { projection });
        }

        static findOne(filter = {}) {
            return new Query(Model, filter, { one: true });
        }

        static async deleteOne(filter = {}) {
            const [record] = Model.matching(filter);
            if (record) remove(record._id);
            return { deletedCount: record ? 1 : 0 };
        }

        static async deleteMany(filter = {}) {
            const found = Model.matching(filter);
            for (const record of found) remove(record._id);
            return { deletedCount: found.length };
        }

        static async updateOne(filter, update) {
            const [record] = Model.matching(filter);
            if (!record) return { matchedCount: 0, modifiedCount: 0 };

            const operators = Object.keys(update).some((key) => key.startsWith("$")) ? update : { $set: update };
            const updated = clone(record);
            for (const [operator, changes] of Object.entries(operators)) {
                for (const [key, value] of Object.entries(changes)) {
                    if (operator === "$set") setPath(updated, key, clone(value));
                    else if (operator === "$unset") setPath(updated, key, undefined);
                    else if (operator === "$inc") setPath(updated, key, (getPath(updated, key) || 0) + value);
                    else throw new Error(`db: unsupported update operator ${operator}`);
                }
            }
            store(updated);
            return { matchedCount: 1, modifiedCount: 1 };
        }

        async save() {
            for (const hook of schema.hooks) await runHook(hook, this);
            if (updatedAt) this[updatedAt] = new Date();
            if (createdAt && this.isNew) this[createdAt] = new Date();

            store(this.toObject());
            this.isNew = false;
            return this;
        }

        async deleteOne() {
            remove(this._id);
            return { deletedCount: 1 };
        }

        markModified() {
            // Every save writes the whole record.
        }

        toObject() {
            const values = {};
            for (const key of fields) {
                if (this[key] !== undefined) values[key] = this[key];
            }
            return clone(values);
        }

        toJSON() {
            return this.toObject();
        }
    }

    if (schema.ttl) {
        const { field, seconds } = schema.ttl;
        setInterval(() => {
            const cutoff = Date.now() - seconds * 1000;
            for (const record of [...records.values()]) {
                if (record[field] && new Date(record[field]).getTime() < cutoff) remove(record._id);
            }
        }, kTtlSweepMs).unref();
    }

    return Model;
}

function open() {
    fs.mkdirSync(kDataDir, { recursive: true });
    console.log(`Saving accounts in ${kDataDir}`);
}

module.exports = { Schema, model, open };
