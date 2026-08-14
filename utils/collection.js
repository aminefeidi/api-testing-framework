import fs from 'node:fs/promises';
import path from 'node:path';
import pmc from 'postman-collection';
const { Collection, ItemGroup } = pmc;

async function findCollectionFiles(folderPath) {
    const entries = await fs.readdir(folderPath, { withFileTypes: true });
    const nested = await Promise.all(entries.map(async (entry) => {
        const entryPath = path.join(folderPath, entry.name);

        if (entry.isDirectory()) {
            return findCollectionFiles(entryPath);
        }

        return entry.name.endsWith('.json') ? [entryPath] : [];
    }));

    return nested.flat();
}

/**
 * Loads all Postman collection JSON files from a directory.
 * @param {string} folderPath
 * @returns {Promise<Collection[]>}
 */
export async function loadCollections(folderPath) {
    const files = await findCollectionFiles(folderPath);

    const collections = await Promise.all(files.map(async (filePath) => {
        const content = await fs.readFile(filePath, 'utf8');
        const json = JSON.parse(content);

        // Postman collections can be exported as { collection: { ... } } or just the collection object itself
        const data = json.collection || json;
        const collection = new Collection(data);
        collection.sourcePath = filePath;
        return collection;
    }));

    // Sorting logic (matches provided snippet pattern but handles non-numeric names)
    return collections.sort((a, b) => {
        const aNum = parseInt(a.name.match(/\[(\d+)\]/)?.[1] || Infinity);
        const bNum = parseInt(b.name.match(/\[(\d+)\]/)?.[1] || Infinity);

        if (aNum !== bNum) return aNum - bNum;
        return a.name.localeCompare(b.name);
    });
}

/**
 * Merges multiple collections into a single one.
 * @param {Collection[]} collections
 * @returns {Collection}
 */
 export function mergeCollections(collections) {
     const merged = new Collection({
         info: {
             name: "FR-ONE Merged Suite",
             description: "All collections merged for single run"
         }
     });

     for (const col of collections) {
         const folder = new ItemGroup({
             name: col.name,
             item: col.items.toJSON(),
             event: col.events.toJSON()
         });

         merged.items.add(folder);
     }

     return merged;
 }
