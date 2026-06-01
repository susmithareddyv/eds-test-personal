import { readBlockConfig } from '../../scripts/aem.js';

/**
 * Release Notes Navigation
 *
 * Dynamically discovers every published release-note version from the EDS
 * query index (see /helix-query.yaml) and renders an accessible, year-grouped
 * navigation. No version list is hard-coded: when a product team publishes a
 * new Word doc, it appears automatically on the next index refresh.
 *
 * Authoring contract (block table in the document):
 *
 *   | Release Notes Nav |                          |
 *   | Title             | Accounting CS Release Notes |
 *   | Source            | /accounting-cs              |  (optional)
 *   | Index             | /query-index.json           |  (optional)
 *
 * - Title:  heading shown above the navigation. Defaults to "Release Notes".
 * - Source: path prefix used to select which entries belong to this product.
 *           Defaults to the first path segment of the current page
 *           (e.g. "/accounting-cs"), so the same block works for any product.
 * - Index:  query-index endpoint to read. Defaults to "/query-index.json".
 */

const DEFAULT_INDEX = '/query-index.json';

/**
 * Normalises an authored path/prefix to a leading-slash, no-trailing-slash form.
 * @param {string} value raw value
 * @returns {string}
 */
function normalizePath(value) {
  if (!value) return '';
  let path = value.trim();
  // authors often paste a full URL via a link cell
  try {
    path = new URL(path).pathname;
  } catch {
    // not a URL, treat as a path
  }
  if (!path.startsWith('/')) path = `/${path}`;
  return path.replace(/\/+$/, '');
}

/**
 * Derives the product prefix from the current page when not authored.
 * "/accounting-cs/2026/version2026-1" -> "/accounting-cs"
 * @returns {string}
 */
function currentProductPrefix() {
  const [, first] = window.location.pathname.split('/');
  return first ? `/${first}` : '';
}

/**
 * Turns a version slug into a human label, e.g.
 * "version2026-1" -> "Version 2026.1".
 * @param {string} slug last path segment
 * @returns {string}
 */
function slugToLabel(slug) {
  const cleaned = slug
    .replace(/^version[-_]?/i, '')
    .replace(/[-_]/g, '.');
  return `Version ${cleaned}`;
}

/**
 * Parses an index row into a release-note descriptor relative to the product.
 * Expects paths shaped like `${prefix}/${year}/${versionSlug}`.
 * @param {object} row query-index row
 * @param {string} prefix product path prefix
 * @returns {object|null} { path, year, label, sortKey } or null if not a match
 */
function toReleaseNote(row, prefix) {
  const path = (row.path || '').replace(/\/+$/, '');
  if (!path.startsWith(`${prefix}/`)) return null;

  const segments = path.slice(prefix.length + 1).split('/').filter(Boolean);
  if (segments.length < 2) return null; // need at least year + version

  const [year, ...rest] = segments;
  const slug = rest[rest.length - 1];
  const label = (row.title && row.title.trim()) || slugToLabel(slug);

  // numeric sort key: prefer publicationDate, fall back to digits in the slug
  let sortKey = Number(row.publicationDate) || Number(row.lastModified) || 0;
  if (!sortKey) {
    const nums = slug.match(/\d+/g);
    if (nums) sortKey = Number(nums.join('').padEnd(8, '0').slice(0, 8));
  }

  return {
    path, year, label, slug, sortKey,
  };
}

/**
 * Fetches and shapes the release notes for a product.
 * @param {string} indexUrl query-index endpoint
 * @param {string} prefix product path prefix
 * @returns {Promise<Map<string, object[]>>} year -> sorted notes (newest first)
 */
async function fetchReleaseNotes(indexUrl, prefix) {
  const resp = await fetch(indexUrl);
  if (!resp.ok) throw new Error(`Failed to load index ${indexUrl}: ${resp.status}`);
  const { data = [] } = await resp.json();

  const notes = data
    .map((row) => toReleaseNote(row, prefix))
    .filter(Boolean);

  // group by year
  const byYear = new Map();
  notes.forEach((note) => {
    if (!byYear.has(note.year)) byYear.set(note.year, []);
    byYear.get(note.year).push(note);
  });

  // sort versions within each year (newest first)
  byYear.forEach((list) => list.sort((a, b) => b.sortKey - a.sortKey || b.slug.localeCompare(a.slug)));

  // return years sorted descending (newest year first)
  return new Map([...byYear.entries()].sort((a, b) => b[0].localeCompare(a[0], undefined, { numeric: true })));
}

/**
 * Builds the DOM for one year group as a collapsible section.
 * @param {string} year
 * @param {object[]} notes
 * @param {string} currentPath
 * @returns {HTMLElement}
 */
function buildYearGroup(year, notes, currentPath) {
  const details = document.createElement('details');
  details.className = 'release-notes-nav-year';

  const summary = document.createElement('summary');
  summary.textContent = year;
  details.append(summary);

  const ul = document.createElement('ul');
  notes.forEach((note) => {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = note.path;
    a.textContent = note.label;
    if (note.path === currentPath) {
      a.setAttribute('aria-current', 'page');
      li.classList.add('is-active');
      details.open = true; // expand the group containing the current page
    }
    li.append(a);
    ul.append(li);
  });
  details.append(ul);

  // open the most recent year by default
  return details;
}

/**
 * loads and decorates the block
 * @param {Element} block The block element
 */
export default async function decorate(block) {
  // 1. Extract configuration
  const config = readBlockConfig(block);
  const title = config.title || 'Release Notes';
  const prefix = normalizePath(config.source) || currentProductPrefix();
  const indexUrl = normalizePath(config.index) || DEFAULT_INDEX;
  const currentPath = window.location.pathname.replace(/\/+$/, '');

  // 2. Build shell
  const nav = document.createElement('nav');
  nav.className = 'release-notes-nav-list';
  nav.setAttribute('aria-label', title);

  const heading = document.createElement('h2');
  heading.className = 'release-notes-nav-title';
  heading.textContent = title;

  block.replaceChildren(heading, nav);

  // 3. Fetch + render
  try {
    const byYear = await fetchReleaseNotes(indexUrl, prefix);

    if (byYear.size === 0) {
      const empty = document.createElement('p');
      empty.className = 'release-notes-nav-empty';
      empty.textContent = 'No release notes have been published yet.';
      nav.append(empty);
      return;
    }

    let first = true;
    byYear.forEach((notes, year) => {
      const group = buildYearGroup(year, notes, currentPath);
      if (first) {
        group.open = true; // newest year expanded by default
        first = false;
      }
      nav.append(group);
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Release notes navigation failed to load', error);
    const errEl = document.createElement('p');
    errEl.className = 'release-notes-nav-empty';
    errEl.textContent = 'Release notes are temporarily unavailable.';
    nav.append(errEl);
  }
}
