export type StoredParagraphStatus = "pending" | "generating" | "ok" | "error";

export type StoredParagraph = {
  id: string;
  text: string;
  speakerModelId: string;
  speakerOverridden: boolean;
  status: StoredParagraphStatus;
  audioUrl?: string;
  audioBlob?: Blob;
  error?: string;
};

export type StoredProject = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  inputText: string;
  selectedModelId: string;
  paragraphs: StoredParagraph[];
};

const DB_NAME = "voicestudio";
const DB_VERSION = 1;
const PROJECTS_STORE_NAME = "projects";

let databasePromise: Promise<IDBDatabase> | null = null;

const openProjectsDatabase = (): Promise<IDBDatabase> => {
  if (databasePromise) {
    return databasePromise;
  }

  databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(PROJECTS_STORE_NAME)) {
        const store = database.createObjectStore(PROJECTS_STORE_NAME, { keyPath: "id" });
        store.createIndex("updatedAt", "updatedAt", { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Unable to open IndexedDB"));
  });

  return databasePromise;
};

const runReadOnly = async <T>(
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> => {
  const database = await openProjectsDatabase();
  return new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(PROJECTS_STORE_NAME, "readonly");
    const store = transaction.objectStore(PROJECTS_STORE_NAME);
    const request = operation(store);

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB read operation failed"));
  });
};

const runReadWrite = async <T>(
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> => {
  const database = await openProjectsDatabase();
  return new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(PROJECTS_STORE_NAME, "readwrite");
    const store = transaction.objectStore(PROJECTS_STORE_NAME);
    const request = operation(store);

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB write operation failed"));
  });
};

export const listProjects = async (): Promise<StoredProject[]> => {
  const projects = await runReadOnly<StoredProject[]>((store) => store.getAll());
  return projects.sort((left, right) => right.updatedAt - left.updatedAt);
};

export const getProject = async (id: string): Promise<StoredProject | undefined> => {
  const project = await runReadOnly<StoredProject | undefined>((store) => store.get(id));
  return project;
};

export const upsertProject = async (project: StoredProject): Promise<void> => {
  await runReadWrite<IDBValidKey>((store) => store.put(project));
};

export const renameProject = async (id: string, name: string): Promise<StoredProject | undefined> => {
  const existing = await getProject(id);
  if (!existing) {
    return undefined;
  }

  const next: StoredProject = {
    ...existing,
    name,
    updatedAt: Date.now(),
  };
  await upsertProject(next);
  return next;
};

export const deleteProject = async (id: string): Promise<void> => {
  await runReadWrite<undefined>((store) => store.delete(id));
};
