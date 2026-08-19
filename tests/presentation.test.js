const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const publicRoot = path.resolve(__dirname, '..', 'web', 'public');
const presentationRoot = path.join(publicRoot, 'presentation');
const slidesRoot = path.join(presentationRoot, 'slides');
const slideFiles = [
  'story/01-hook.html',
  'story/02-question.html',
  'story/03-intro-clean.html',
  'story/04-problem-definition.html',
  'story/05-location-problem.html',
  'story/06-evidence.html',
  'story/07-memory-problem.html',
  'story/08-market.html',
  'story/09-customer.html',
  'story/10-solution.html',
  'story/11-system.html',
  'story/12-app.html',
  'story/13-live.html',
  'story/14-validation.html',
  'story/15-close.html'
];

function read(relativePath) {
  return fs.readFileSync(path.join(presentationRoot, relativePath), 'utf8');
}

test('presentation module has the separated entry files', () => {
  for (const file of ['index.html', 'styles.css', 'slides.js']) {
    assert.equal(fs.existsSync(path.join(presentationRoot, file)), true, file + ' is missing');
  }
});

test('slide registry maps every slide to an existing HTML file', () => {
  const registry = read('slides.js');
  const paths = [...registry.matchAll(/file:\s*'([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(paths, slideFiles.map((file) => 'slides/' + file));
  for (const relativePath of paths) {
    assert.equal(fs.existsSync(path.join(presentationRoot, relativePath)), true, relativePath + ' is missing');
  }
});

test('each story slide is independently renderable and uses the shared design system', () => {
  for (const file of slideFiles) {
    const source = fs.readFileSync(path.join(slidesRoot, file), 'utf8');
    assert.match(source, /<html\s+lang="ko">/i, file + ' language is missing');
    assert.match(source, /<meta\s+name="viewport"/i, file + ' viewport is missing');
    assert.match(source, /href="\.\.\/\.\.\/slide\.css"/i, file + ' shared slide css is missing');
    assert.match(source, /\.\.\/\.\.\/slide-runtime\.js/i, file + ' shared runtime is missing');
  }
});

test('live slide exposes both iframe slots and the parent embed bridge', () => {
  const source = fs.readFileSync(path.join(slidesRoot, 'story/13-live.html'), 'utf8');
  assert.match(source, /id="phoneFrame"/);
  assert.match(source, /id="appFrame"/);
  assert.match(source, /PRESENTATION_EMBEDS/);
  assert.match(source, /mount\('appFrame'/);
  assert.match(source, /mount\('phoneFrame'/);
});

test('story deck keeps the 3D, GSAP and anime.js hooks', () => {
  const source = fs.readFileSync(path.join(slidesRoot, 'story/01-hook.html'), 'utf8');
  assert.match(source, /three\.min\.js/);
  assert.match(source, /gsap\.min\.js/);
  assert.match(source, /anime\.min\.js/);
  assert.match(source, /WebGLRenderer/);
  assert.match(source, /ExtrudeGeometry/);
});

test('market and customer slides preserve source-safe placeholders', () => {
  const market = fs.readFileSync(path.join(slidesRoot, 'story/08-market.html'), 'utf8');
  const customer = fs.readFileSync(path.join(slidesRoot, 'story/09-customer.html'), 'utf8');
  assert.match(market, /180\.12/);
  assert.match(market, /848\.47/);
  assert.match(market, /21\.40/);
  assert.match(market, /fortunebusinessinsights\.com/);
  assert.match(customer, /옷이 많은 가정/);
  assert.match(customer, /소형 옷가게·쇼룸/);
  assert.match(customer, /1인 가구/);
});
