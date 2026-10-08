import { excerptOf, searchTerms } from '../../src/content-reader/views/search/excerpt';

describe('the words a query asks for', () => {
  it('keeps the words, drops the operators, longest first', () => {
    expect(searchTerms('rate -card "pricing model" or x')).toEqual(['pricing model', 'rate']);
  });

  it('folds case and never repeats a word', () => {
    expect(searchTerms('Pricing pricing')).toEqual(['pricing']);
  });
});

describe('the block a hit landed in', () => {
  const page =
    '<h2 id="a">Access</h2>' +
    '<p>Every <a href="/x/handbook/setup">grant</a> narrows.</p>' +
    '<ul><li><p>Groups and <strong>pricing</strong> tiers</p></li></ul>' +
    '<pre><code class="language-yaml"><span class="spr-code-attr">indexable</span>: false</code></pre>';

  const html = (markup: string, terms: string[]) => excerptOf(markup, terms)?.html ?? null;

  it('is the innermost block holding the term, as the page draws it', () => {
    expect(html(page, ['indexable'])).toBe(
      '<pre><code class="language-yaml"><span class="spr-code-attr"><mark>indexable</mark></span>: false</code></pre>',
    );
    expect(html(page, ['pricing'])).toBe(
      '<p>Groups and <strong><mark>pricing</mark></strong> tiers</p>',
    );
  });

  it('unwraps a link to its text and drops a picture', () => {
    expect(html(page, ['grant'])).toBe('<p>Every <mark>grant</mark> narrows.</p>');
    expect(html('<p>see <img src="/x/a.png" alt="a"> here</p>', ['here'])).toBe(
      '<p>see  <mark>here</mark></p>',
    );
  });

  it('marks text and never an attribute', () => {
    expect(html('<p><abbr title="grant">a grant</abbr></p>', ['grant'])).toBe(
      '<p><abbr title="grant">a <mark>grant</mark></abbr></p>',
    );
  });

  it('writes text back out escaped', () => {
    expect(html('<p>a &lt;script&gt; tag &amp; more</p>', ['tag'])).toBe(
      '<p>a &lt;script&gt; <mark>tag</mark> &amp; more</p>',
    );
    expect(html('<p title="a &quot;b&quot;">b</p>', ['b'])).toBe(
      '<p title="a &quot;b&quot;"><mark>b</mark></p>',
    );
  });

  it('draws a block that only makes sense in its parent as a division', () => {
    expect(html('<ul><li>one <em>two</em></li></ul>', ['two'])).toBe(
      '<div>one <em><mark>two</mark></em></div>',
    );
    expect(html('<h3>Pricing</h3>', ['pricing'])).toBe('<p><mark>Pricing</mark></p>');
  });

  it('shows the whole table for a match in a cell', () => {
    const table =
      '<table><thead><tr><th>Tier</th><th align="right">Price</th></tr></thead>' +
      '<tbody><tr><td>Team</td><td align="right">1,850</td></tr></tbody></table>';
    expect(html(table, ['1,850'])).toBe(
      '<table><thead><tr><th>Tier</th><th align="right">Price</th></tr></thead>' +
        '<tbody><tr><td>Team</td><td align="right"><mark>1,850</mark></td></tr></tbody></table>',
    );
  });

  it('answers nothing when no block spells the term', () => {
    expect(html(page, ['prices'])).toBeNull();
    expect(html(page, [])).toBeNull();
  });

  it('cuts a long block with its tags still balanced', () => {
    const long = `<pre><code>needle ${'x'.repeat(5000)} tail</code></pre>`;
    const excerpt = html(long, ['needle']) as string;
    expect(excerpt.length).toBeLessThan(1500);
    expect(excerpt.endsWith('…</code></pre>')).toBe(true);
    expect(excerpt).not.toContain('tail');
  });

  it('treats the term as text, not as a pattern', () => {
    expect(html('<p>a.b and axb</p>', ['a.b'])).toBe('<p><mark>a.b</mark> and axb</p>');
  });
});

describe('the text directive a result carries', () => {
  it('names the match with the words either side of it, from the same text node', () => {
    const { fragment } = excerptOf('<p>Every single grant narrows the set, always.</p>', [
      'grant',
    ])!;
    expect(fragment).toBe(':~:text=Every%20single-,grant,-narrows%20the%20set%2C');
  });

  it('is one directive per term, for the first place each was found', () => {
    const { fragment } = excerptOf('<p>rate card, rate card</p>', ['rate', 'card'])!;
    expect(fragment.split('&text=')).toHaveLength(2);
    expect(fragment.startsWith(':~:text=')).toBe(true);
  });

  it('encodes the three characters the syntax itself uses', () => {
    const { fragment } = excerptOf('<p>a-b, & d term here</p>', ['term'])!;
    expect(fragment).toBe(':~:text=a%2Db%2C%20%26%20d-,term,-here');
  });

  it('keeps the context short of the budget cut', () => {
    const { fragment } = excerptOf('<p>term</p>', ['term'])!;
    expect(fragment).toBe(':~:text=term');
  });
});
