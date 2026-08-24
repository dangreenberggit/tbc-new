import Ajv from 'ajv';
import path from 'node:path';
import { fileURLToPath } from 'url';
import fs from 'node:fs/promises';
import { glob } from 'glob';

const localesPath = 'assets/locales';

const ajv = new Ajv();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const loadSchemaFiles = async () => {
	const schemas = {};
	const schemaFiles = await fs.readdir(path.join(__dirname, 'schemas'));
	for (const file of schemaFiles) {
		const data = await fs.readFile(path.join(__dirname, 'schemas', file), 'utf-8');
		const schemaName = file.split('.')[0];
		schemas[schemaName] = JSON.parse(data);
	}
	return schemas;
};

const validateSchemas = async () => {
	const schemas = await loadSchemaFiles();
	let hasError = false;
	let validatedCount = 0;

	for (const [name, schema] of Object.entries(schemas)) {
		const validate = ajv.compile(schema);
		// Forward slashes, not path.join: on Windows path.join yields
		// backslashes, glob reads those as escape characters, zero files
		// match, and this gate exits 0 having validated nothing. It looked
		// green on Windows while the schema violation below was real and
		// firing on CI.
		const filePaths = await glob([__dirname, localesPath, `**/${name}.json`].join('/'));

		// A schema whose glob stops matching validates nothing while still
		// exiting 0 -- exactly how the Windows path.join bug above stayed
		// invisible. Count what was validated so that cannot recur.
		//
		// Zero matches is reported but not fatal: upstream ships
		// gear.schema.json with no gear.json locale file, and has since
		// before this branch. Failing on that would make the gate red for a
		// gap this fork did not create and cannot fix here.
		if (filePaths.length === 0) {
			console.log(`⚠  no locale file for schema ${name} -- nothing validated`);
			continue;
		}
		validatedCount += filePaths.length;

		for (const filePath of filePaths) {
			// Normalise before splitting: glob returns native separators, so on
			// Windows the path contains backslashes and a split on the
			// forward-slash localesPath yields undefined.
			const relativePath = filePath.split(/[\\\/]/).slice(-2).join('/');
			const data = await fs.readFile(filePath, 'utf-8');

			const valid = validate(JSON.parse(data));

			if (valid) {
				console.log(`✅ ${relativePath} is valid`);
			} else {
				if (!hasError) hasError = true;
				console.log(
					`❌ ${relativePath} is invalid:`,
					ajv.errorsText(validate.errors, {
						dataVar: 'schema',
					}),
				);
			}
		}
	}
	// The real regression guard: if the globs collectively matched nothing,
	// this gate validated nothing and must not report success.
	if (validatedCount === 0) {
		console.log(`❌ no locale files matched any schema -- the gate validated nothing`);
		process.exit(1);
	}
	console.log(`validated ${validatedCount} locale file(s)`);
	if (hasError) process.exit(1);
};

validateSchemas();
