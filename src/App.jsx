import { useEffect, useMemo, useState } from 'react';

const STORAGE_KEY = 'keygen.doneLinks';
const PRESET_COUNTS = [10, 20, 50, 100];
const CHARACTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const CODE_LENGTH = 16;
const MAX_CUSTOM_COUNT = 1000;

function createCode() {
  let value = '';

  for (let index = 0; index < CODE_LENGTH; index += 1) {
    const randomIndex = Math.floor(Math.random() * CHARACTERS.length);
    value += CHARACTERS[randomIndex];
  }

  return value;
}

function normalizeBase(input) {
  return input.endsWith('/') ? input : `${input}/`;
}

function readDoneLinks() {
  if (typeof window === 'undefined') {
    return {};
  }

  try {
    const storedValue = window.localStorage.getItem(STORAGE_KEY);
    return storedValue ? JSON.parse(storedValue) : {};
  } catch (error) {
    return {};
  }
}

function App() {
  const [baseInput, setBaseInput] = useState('');
  const [selectedCount, setSelectedCount] = useState(10);
  const [customCount, setCustomCount] = useState('');
  const [generatedLinks, setGeneratedLinks] = useState([]);
  const [doneLinks, setDoneLinks] = useState(() => readDoneLinks());

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(doneLinks));
    } catch (error) {
      // Ignore storage issues so generation still works in restricted browsers.
    }
  }, [doneLinks]);

  const customError = useMemo(() => {
    if (selectedCount !== 'custom') {
      return '';
    }

    if (customCount.trim() === '') {
      return 'Enter a custom quantity to generate links.';
    }

    const numericValue = Number(customCount);

    if (!Number.isInteger(numericValue) || numericValue <= 0) {
      return 'Custom quantity must be a whole number greater than 0.';
    }

    if (numericValue > MAX_CUSTOM_COUNT) {
      return `Custom quantity cannot be more than ${MAX_CUSTOM_COUNT}.`;
    }

    return '';
  }, [customCount, selectedCount]);

  const resolvedCount = selectedCount === 'custom' ? Number(customCount) : selectedCount;
  const trimmedInput = baseInput.trim();
  const canGenerate = trimmedInput !== '' && customError === '';
  const doneCount = generatedLinks.filter((item) => Boolean(doneLinks[item.fullLink])).length;

  function handleGenerate(event) {
    event.preventDefault();

    if (!canGenerate) {
      return;
    }

    const normalizedBase = normalizeBase(trimmedInput);
    const knownLinks = new Set(generatedLinks.map((item) => item.fullLink));
    const nextLinks = [];

    while (nextLinks.length < resolvedCount) {
      const suffix = createCode();
      const fullLink = `${normalizedBase}${suffix}`;

      if (knownLinks.has(fullLink)) {
        continue;
      }

      knownLinks.add(fullLink);
      nextLinks.push({
        id: `${Date.now()}-${nextLinks.length}-${suffix}`,
        suffix,
        fullLink,
        done: Boolean(doneLinks[fullLink]),
      });
    }

    setGeneratedLinks(nextLinks);
  }

  function handleLinkClick(fullLink) {
    setDoneLinks((currentValue) => ({
      ...currentValue,
      [fullLink]: true,
    }));
  }

  function clearResults() {
    setGeneratedLinks([]);
  }

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div className="hero-copy">
          <p className="eyebrow">Black / White / Minimal</p>
          <h1>Generate clean suffix links in one click.</h1>
          <p className="hero-text">
            Paste any link or base text, choose how many results you want, and generate
            full links with a sharp alphanumeric key at the end.
          </p>
        </div>

        <form className="generator-panel" onSubmit={handleGenerate}>
          <label className="input-group" htmlFor="base-input">
            <span>Base link or text</span>
            <input
              id="base-input"
              name="base-input"
              type="text"
              placeholder="https://example.com/invite"
              value={baseInput}
              onChange={(event) => setBaseInput(event.target.value)}
            />
          </label>

          <div className="controls-row">
            <div className="chip-group" aria-label="Select quantity">
              {PRESET_COUNTS.map((count) => (
                <button
                  key={count}
                  className={selectedCount === count ? 'chip active' : 'chip'}
                  type="button"
                  onClick={() => setSelectedCount(count)}
                >
                  {count}
                </button>
              ))}
              <button
                className={selectedCount === 'custom' ? 'chip active' : 'chip'}
                type="button"
                onClick={() => setSelectedCount('custom')}
              >
                Custom
              </button>
            </div>

            {selectedCount === 'custom' ? (
              <label className="custom-input" htmlFor="custom-count">
                <span>Qty</span>
                <input
                  id="custom-count"
                  name="custom-count"
                  type="number"
                  min="1"
                  max={MAX_CUSTOM_COUNT}
                  step="1"
                  placeholder="250"
                  value={customCount}
                  onChange={(event) => setCustomCount(event.target.value)}
                />
              </label>
            ) : null}
          </div>

          {customError ? <p className="validation-message">{customError}</p> : null}

          <div className="actions-row">
            <button className="primary-button" type="submit" disabled={!canGenerate}>
              Generate
            </button>
            <button
              className="secondary-button"
              type="button"
              onClick={clearResults}
              disabled={generatedLinks.length === 0}
            >
              Clear current list
            </button>
          </div>
        </form>
      </section>

      <section className="results-panel" aria-live="polite">
        <header className="results-header">
          <div>
            <p className="results-label">Generated links</p>
            <h2>{generatedLinks.length === 0 ? 'Nothing generated yet' : `${generatedLinks.length} ready`}</h2>
          </div>
          <div className="results-meta">
            <span>{doneCount} done</span>
            <span>{generatedLinks.length - doneCount} pending</span>
          </div>
        </header>

        {generatedLinks.length === 0 ? (
          <div className="empty-state">
            <p>Your generated links will appear here with a live done status.</p>
          </div>
        ) : (
          <div className="results-list">
            {generatedLinks.map((item, index) => {
              const isDone = Boolean(doneLinks[item.fullLink]);

              return (
                <a
                  key={item.id}
                  className={isDone ? 'result-card done' : 'result-card'}
                  href={item.fullLink}
                  onClick={() => handleLinkClick(item.fullLink)}
                  rel="noreferrer"
                  target="_blank"
                >
                  <div className="result-topline">
                    <span className="result-index">{String(index + 1).padStart(2, '0')}</span>
                    <span className="result-code">{item.suffix}</span>
                    <span className="status-pill">{isDone ? 'Done' : 'Open'}</span>
                  </div>
                  <p className="result-link">{item.fullLink}</p>
                </a>
              );
            })}
          </div>
        )}
      </section>
    </main>
  );
}

export default App;
