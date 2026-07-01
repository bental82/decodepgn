import spriteRaw from './pieces.svg?raw'

// The cburnett piece sprite, inlined once and hidden. Every <use href="#wk"> on
// the board then resolves against this same-document copy. We deliberately do
// NOT reference the sprite as an external file (<use href="pieces.svg#wk">):
// iOS Safari renders external <use> references unreliably, which showed up as a
// "scrambled" board on iPhone. The XML prolog is stripped so the markup can be
// injected as HTML.
const SPRITE = spriteRaw.replace(/<\?xml[\s\S]*?\?>/, '')

export default function PieceSprite() {
  return (
    <div aria-hidden="true" className="piece-defs" dangerouslySetInnerHTML={{ __html: SPRITE }} />
  )
}
