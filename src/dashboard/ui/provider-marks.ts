/**
 * The marks that name an identity provider or a content source's kind.
 *
 * Logos that are not Lucide's and never will be: they are the trademarks of the
 * organisations they name, drawn here so a tile, a row or a row in a dropdown says
 * *which* one it is before its title is read. Nominative use — the mark identifies
 * the thing it is the mark of — and nothing more is claimed by it.
 *
 * **First-party bytes, and no request.** They are literals in this file, emitted
 * as a per-page sprite exactly as `renderSprite` does for Lucide, so a page
 * carries one copy of each mark it uses and fetches nothing. That is not only
 * about speed: `img-src 'self'` refuses a remote logo, and a logo fetched from
 * the provider would tell that provider when this instance's dashboard is being
 * read.
 *
 * Which of them keeps its colour is decided one mark at a time, by whether the
 * colour *is* the mark. The Octocat and the OpenID logo are monochrome and are
 * drawn in `currentColor`, so they follow the theme — a black Octocat on a dark
 * page is a mark nobody can see. Microsoft's four squares, the tanuki's three
 * oranges, Gitea's green, Forgejo's orange and Git's red cannot be recoloured
 * without becoming a different mark, and each is a mid-tone that reads on a light
 * page and a dark one — which is the test the black mark failed. Their values are
 * literal here rather than in the stylesheet, which is what keeps `dashboard.css` free
 * of hard-coded colour and themeable by a template that has never heard of Entra.
 *
 * Sources: the GitHub Octocat mark, the Microsoft logo, the OpenID logo, and the
 * GitLab, Gitea, Forgejo and Git marks, each normalised — prolog, DOCTYPE, ids, fixed `width`/`height` and the `xlink`
 * namespace removed, and each viewBox trimmed to its own shapes. The DOCTYPE is worth naming: it is exactly the kind of
 * declaration `parseBrandLogo` refuses in an uploaded logo, and there is no
 * reason for one to survive into a page here either.
 */

interface Mark {
  viewBox: string;
  /** Shapes only — no `svg` element, no ids, nothing that could collide. */
  body: string;
  /** Presentation attributes the shapes need, for a mark that is drawn in strokes. */
  attrs?: string;
}

export const PROVIDER_MARKS: Record<string, Mark> = {
  /*
    The viewBoxes are trimmed to the shapes they hold, which is not tidiness: a box
    with the artist's own padding in it draws a mark smaller than its neighbours
    and leaves a band of nothing between the logo and the name that no `gap` put
    there. Microsoft's squares live in 5..27 of 32 — a sixth of the box on every
    side — and the OpenID logo sits in the lower two thirds of a box a third
    bigger than it is. Each is stated as the bounding box of its own path.
  */
  microsoft: {
    viewBox: '5 5 22 22',
    body:
      '<rect x="17" y="17" width="10" height="10" fill="#FEBA08"/>' +
      '<rect x="5" y="17" width="10" height="10" fill="#05A6F0"/>' +
      '<rect x="17" y="5" width="10" height="10" fill="#80BC06"/>' +
      '<rect x="5" y="5" width="10" height="10" fill="#F25325"/>',
  },
  github: {
    viewBox: '0 0 20 20',
    body:
      '<g transform="translate(-84 -7399)" fill="currentColor">' +
      '<path d="M94,7399 C99.523,7399 104,7403.59 104,7409.253 C104,7413.782 101.138,7417.624 97.167,7418.981 C96.66,7419.082 96.48,7418.762 96.48,7418.489 C96.48,7418.151 96.492,7417.047 96.492,7415.675 C96.492,7414.719 96.172,7414.095 95.813,7413.777 C98.04,7413.523 100.38,7412.656 100.38,7408.718 C100.38,7407.598 99.992,7406.684 99.35,7405.966 C99.454,7405.707 99.797,7404.664 99.252,7403.252 C99.252,7403.252 98.414,7402.977 96.505,7404.303 C95.706,7404.076 94.85,7403.962 94,7403.958 C93.15,7403.962 92.295,7404.076 91.497,7404.303 C89.586,7402.977 88.746,7403.252 88.746,7403.252 C88.203,7404.664 88.546,7405.707 88.649,7405.966 C88.01,7406.684 87.619,7407.598 87.619,7408.718 C87.619,7412.646 89.954,7413.526 92.175,7413.785 C91.889,7414.041 91.63,7414.493 91.54,7415.156 C90.97,7415.418 89.522,7415.871 88.63,7414.304 C88.63,7414.304 88.101,7413.319 87.097,7413.247 C87.097,7413.247 86.122,7413.234 87.029,7413.87 C87.029,7413.87 87.684,7414.185 88.139,7415.37 C88.139,7415.37 88.726,7417.2 91.508,7416.58 C91.513,7417.437 91.522,7418.245 91.522,7418.489 C91.522,7418.76 91.338,7419.077 90.839,7418.982 C86.865,7417.627 84,7413.783 84,7409.253 C84,7403.59 88.478,7399 94,7399"/>' +
      '</g>',
  },
  /*
    The one kind that is nobody's brand: a magic link is an email, and an envelope
    is what an envelope looks like. Lucide's `mail`, copied here as a literal
    rather than pulled from the icon set at render time — the Lucide sprite on a
    page is assembled from what its *nav* names, and a tile depending on that is a
    tile that loses its picture the day the left column changes. Stroke rather
    than fill, which is what every Lucide glyph is; the attributes sit on the
    symbol so the shapes stay shapes.
  */
  mail: {
    viewBox: '0 0 24 24',
    attrs:
      'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"',
    body:
      '<rect width="20" height="16" x="2" y="4" rx="2"/>' +
      '<path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
  },
  openid: {
    viewBox: '100 286 800 741',
    body: '<path fill="currentColor" d="M585 286l-121 60v606q-69 -9 -124.5 -35.5t-87 -65t-31.5 -83.5q0 -42 28.5 -79.5t79 -63.5t113.5 -37v-77q-97 11 -175 48t-122 91q-45 55 -45 118q0 65 49 122q47 55 130 91.5t185 45.5l121 -57v-684zM606 511v77q71 12 125 43l-65 37l234 51l-17 -173l-62 35 q-91 -55 -215 -70z"/>',
  },
  /*
    The forges, added when the kind a content source is became a picture as well as
    a word. Four brands and one project, and all five keep their own colour: unlike
    the Octocat these are *defined* by it — a red Git lozenge, an orange Forgejo, a
    green Gitea, the tanuki's three oranges — and each is a mid-tone that reads on a
    light page and a dark one, which is the test the black mark failed.
  */
  gitlab: {
    // The tanuki fills its 32 grid; the paths run 0.5..31.5 in both axes.
    viewBox: '0 0 32 32',
    body:
      '<path fill="#E24329" d="m31.46 12.78-.04-.12-4.35-11.35A1.14 1.14 0 0 0 25.94.6c-.24 0-.47.1-.66.24-.19.15-.33.36-.39.6l-2.94 9h-11.9l-2.94-9A1.14 1.14 0 0 0 6.07.58a1.15 1.15 0 0 0-1.14.72L.58 12.68l-.05.11a8.1 8.1 0 0 0 2.68 9.34l.02.01.04.03 6.63 4.97 3.28 2.48 2 1.52a1.35 1.35 0 0 0 1.62 0l2-1.52 3.28-2.48 6.67-5h.02a8.09 8.09 0 0 0 2.7-9.36Z"/>' +
      '<path fill="#FC6D26" d="m31.46 12.78-.04-.12a14.75 14.75 0 0 0-5.86 2.64l-9.55 7.24 6.09 4.6 6.67-5h.02a8.09 8.09 0 0 0 2.67-9.36Z"/>' +
      '<path fill="#FCA326" d="m9.9 27.14 3.28 2.48 2 1.52a1.35 1.35 0 0 0 1.62 0l2-1.52 3.28-2.48-6.1-4.6-6.07 4.6Z"/>' +
      '<path fill="#FC6D26" d="M6.44 15.3a14.71 14.71 0 0 0-5.86-2.63l-.05.12a8.1 8.1 0 0 0 2.68 9.34l.02.01.04.03 6.63 4.97 6.1-4.6-9.56-7.24Z"/>',
  },
  gitea: {
    viewBox: '0 0 24 24',
    body: '<path fill="#609926" d="M4.209 4.603c-.247 0-.525.02-.84.088-.333.07-1.28.283-2.054 1.027C-.403 7.25.035 9.685.089 10.052c.065.446.263 1.687 1.21 2.768 1.749 2.141 5.513 2.092 5.513 2.092s.462 1.103 1.168 2.119c.955 1.263 1.936 2.248 2.89 2.367 2.406 0 7.212-.004 7.212-.004s.458.004 1.08-.394c.535-.324 1.013-.893 1.013-.893s.492-.527 1.18-1.73c.21-.37.385-.729.538-1.068 0 0 2.107-4.471 2.107-8.823-.042-1.318-.367-1.55-.443-1.627-.156-.156-.366-.153-.366-.153s-4.475.252-6.792.306c-.508.011-1.012.023-1.512.027v4.474l-.634-.301c0-1.39-.004-4.17-.004-4.17-1.107.016-3.405-.084-3.405-.084s-5.399-.27-5.987-.324c-.187-.011-.401-.032-.648-.032zm.354 1.832h.111s.271 2.269.6 3.597C5.549 11.147 6.22 13 6.22 13s-.996-.119-1.641-.348c-.99-.324-1.409-.714-1.409-.714s-.73-.511-1.096-1.52C1.444 8.73 2.021 7.7 2.021 7.7s.32-.859 1.47-1.145c.395-.106.863-.12 1.072-.12zm8.33 2.554c.26.003.509.127.509.127l.868.422-.529 1.075a.686.686 0 0 0-.614.359.685.685 0 0 0 .072.756l-.939 1.924a.69.69 0 0 0-.66.527.687.687 0 0 0 .347.763.686.686 0 0 0 .867-.206.688.688 0 0 0-.069-.882l.916-1.874a.667.667 0 0 0 .237-.02.657.657 0 0 0 .271-.137 8.826 8.826 0 0 1 1.016.512.761.761 0 0 1 .286.282c.073.21-.073.569-.073.569-.087.29-.702 1.55-.702 1.55a.692.692 0 0 0-.676.477.681.681 0 1 0 1.157-.252c.073-.141.141-.282.214-.431.19-.397.515-1.16.515-1.16.035-.066.218-.394.103-.814-.095-.435-.48-.638-.48-.638-.467-.301-1.116-.58-1.116-.58s0-.156-.042-.27a.688.688 0 0 0-.148-.241l.516-1.062 2.89 1.401s.48.218.583.619c.073.282-.019.534-.069.657-.24.587-2.1 4.317-2.1 4.317s-.232.554-.748.588a1.065 1.065 0 0 1-.393-.045l-.202-.08-4.31-2.1s-.417-.218-.49-.596c-.083-.31.104-.691.104-.691l2.073-4.272s.183-.37.466-.497a.855.855 0 0 1 .35-.077z"/>',
  },
  forgejo: {
    viewBox: '0 0 24 24',
    body: '<path fill="#FB923C" d="M16.7773 0c1.6018 0 2.9004 1.2986 2.9004 2.9005s-1.2986 2.9004-2.9004 2.9004c-1.0854 0-2.0315-.596-2.5288-1.4787H12.91c-2.3322 0-4.2272 1.8718-4.2649 4.195l-.0007 2.1175a7.0759 7.0759 0 0 1 4.148-1.4205l.1176-.001 1.3385.0002c.4973-.8827 1.4434-1.4788 2.5288-1.4788 1.6018 0 2.9004 1.2986 2.9004 2.9005s-1.2986 2.9004-2.9004 2.9004c-1.0854 0-2.0315-.596-2.5288-1.4787H12.91c-2.3322 0-4.2272 1.8718-4.2649 4.195l-.0007 2.319c.8827.4973 1.4788 1.4434 1.4788 2.5287 0 1.602-1.2986 2.9005-2.9005 2.9005-1.6018 0-2.9004-1.2986-2.9004-2.9005 0-1.0853.596-2.0314 1.4788-2.5287l-.0002-9.9831c0-3.887 3.1195-7.0453 6.9915-7.108l.1176-.001h1.3385C14.7458.5962 15.692 0 16.7773 0ZM7.2227 19.9052c-.6596 0-1.1943.5347-1.1943 1.1943s.5347 1.1943 1.1943 1.1943 1.1944-.5347 1.1944-1.1943-.5348-1.1943-1.1944-1.1943Zm9.5546-10.4644c-.6596 0-1.1944.5347-1.1944 1.1943s.5348 1.1943 1.1944 1.1943c.6596 0 1.1943-.5347 1.1943-1.1943s-.5347-1.1943-1.1943-1.1943Zm0-7.7346c-.6596 0-1.1944.5347-1.1944 1.1943s.5348 1.1943 1.1944 1.1943c.6596 0 1.1943-.5347 1.1943-1.1943s-.5347-1.1943-1.1943-1.1943Z"/>',
  },
  /*
    Git itself, for a plain remote — which is not a forge and is the one kind here
    with no vendor behind it. The mark is the project's own, so the row says "a git
    remote, behind no API" in a picture before the label says it in three words.
  */
  git: {
    viewBox: '0 0 256 256',
    body: '<path fill="#DE4C36" d="M251.172 116.594L139.4 4.828c-6.433-6.437-16.873-6.437-23.314 0l-23.21 23.21 29.443 29.443c6.842-2.312 14.688-.761 20.142 4.693 5.48 5.489 7.02 13.402 4.652 20.266l28.375 28.376c6.865-2.365 14.786-.835 20.269 4.657 7.663 7.66 7.663 20.075 0 27.74-7.665 7.666-20.08 7.666-27.749 0-5.764-5.77-7.188-14.235-4.27-21.336l-26.462-26.462-.003 69.637a19.82 19.82 0 0 1 5.188 3.71c7.663 7.66 7.663 20.076 0 27.747-7.665 7.662-20.086 7.662-27.74 0-7.663-7.671-7.663-20.086 0-27.746a19.654 19.654 0 0 1 6.421-4.281V94.196a19.378 19.378 0 0 1-6.421-4.281c-5.806-5.798-7.202-14.317-4.227-21.446L81.47 39.442l-76.64 76.635c-6.44 6.443-6.44 16.884 0 23.322l111.774 111.768c6.435 6.438 16.873 6.438 23.316 0l111.251-111.249c6.438-6.44 6.438-16.887 0-23.324"/>',
  },
};

/**
 * The symbols a page needs, once each.
 *
 * The same shape as the Lucide sprite and for the same reasons — one copy per
 * distinct mark, `<use>` at each occurrence, no request before first paint. A name
 * this does not know contributes nothing rather than an empty symbol: a `<use>`
 * pointing at an id that is not there draws nothing either way, and the honest
 * version of "we have no mark for this" is no mark.
 */
export function markSprite(names: Iterable<string>): string {
  const wanted = [...new Set([...names].filter((name) => name in PROVIDER_MARKS))];
  if (wanted.length === 0) return '';
  const symbols = wanted
    .map((name) => {
      const mark = PROVIDER_MARKS[name];
      const attrs = mark.attrs ? ` ${mark.attrs}` : '';
      return `<symbol id="m-${name}" viewBox="${mark.viewBox}"${attrs}>${mark.body}</symbol>`;
    })
    .join('');
  // `display="none"`, not `hidden` alone — the trap `renderSprite` carries the
  // long version of: the UA rule behind the attribute is `[hidden]{display:none}`
  // in a sheet whose default namespace is XHTML, so it never matches an
  // SVG-namespace element, and the sprite renders as a 300×150 empty box above
  // everything else on the page. It did exactly that here too. The presentation
  // attribute needs no stylesheet, which is what a page has to be correct without.
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" display="none" hidden aria-hidden="true">` +
    `${symbols}</svg>`
  );
}

/** Whether a mark exists, which is what a caller asks before naming one. */
export function markExists(name: string): boolean {
  return name in PROVIDER_MARKS;
}

/**
 * A reference into the page's own sprite, for a mark beside text.
 *
 * The counterpart to `renderIconRef`, and the shape a *row* wants: a table of
 * repositories draws the same two or three marks over and over, and the GitHub
 * Octocat is a kilobyte of path data each time it is written out. The `<symbol>`
 * carries its own `viewBox`, so only the size is left to say — stated as
 * attributes, exactly as `renderIconRef` states them, because the markup is the
 * one place a size is certain to reach.
 *
 * A name this file has no mark for contributes nothing: a `<use>` pointing at an
 * id the sprite does not hold draws an empty box the size of the attributes.
 */
export function renderMarkRef(name: string, className = 'spr-icon'): string {
  if (!markExists(name)) return '';
  const escaped = className.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return (
    `<svg class="${escaped}" width="16" height="16" aria-hidden="true">` +
    `<use href="#m-${name}"/></svg>`
  );
}

/**
 * One mark, whole, with its shapes inline rather than a reference into a sprite.
 *
 * The counterpart to `renderInlineIcon`, and it exists for a sharper version of
 * the same reason. A mark drawn inside an `<option>` is *cloned* into the closed
 * control when the browser draws the list itself — see the dropdown rules in
 * `dashboard.css` — and a clone is not a place to find out whether a `<use>` still
 * resolves or whether an author rule still reaches. Inline shapes need nothing
 * else on the page to be true.
 *
 * That is also why the size is an attribute and not a rule. An `<svg>` with only
 * a `viewBox` falls back to the replaced element's default box, and the copy in
 * the closed control is out of the stylesheet's reach — so a mark that depended
 * on a rule to be small would draw there at the size of a playing card, which is
 * the trap `renderInlineIcon`'s callers hit from the other side. Sixteen pixels,
 * exactly as `renderIconRef` states it.
 */
export function renderInlineMark(name: string, className: string): string {
  const mark = PROVIDER_MARKS[name];
  if (!mark) return '';
  const attrs = mark.attrs ? ` ${mark.attrs}` : '';
  const escaped = className.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return (
    `<svg class="${escaped}" width="16" height="16" viewBox="${mark.viewBox}"${attrs} ` +
    `aria-hidden="true">${mark.body}</svg>`
  );
}
