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

	for (const [name, schema] of Object.entries(schemas)) {
		const validate = ajv.compile(schema);
		// Forward slashes, not path.join: on Windows path.join yields
		// backslashes, glob reads those as escape characters, zero files
		// match, and this gate exits 0 having validated nothing. It looked
		// green on Windows while the schema violation below was real and
		// firing on CI.
		const filePaths = await glob([__dirname, localesPath, `**/${name}.json`].join('/'));

		for (const filePath of filePaths) {
			// Normalise before splitting: glob returns native separators, so on
			// Windows the path contains backslashes and a split on the
			// forward-slash localesPath yields undefined.
			const relativePath = filePath.split(/[\/]/).slice(-2).join('/');
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
	if (hasError) process.exit(1);
};

validateSchemas();
