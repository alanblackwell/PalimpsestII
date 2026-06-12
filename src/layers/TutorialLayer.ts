import { Layer }           from '../core/Layer.js'
import { ValueType }       from '../core/types.js'
import type { Ctx2D }      from '../core/types.js'

// ------------------------------------------------------------
// TutorialLayer — placeholder for the guided tutorial experience
// ------------------------------------------------------------
// Currently blank. Tutorial content and navigation will be added
// in a future session.

export class TutorialLayer extends Layer {
  readonly types: ReadonlySet<ValueType> = new Set()

  constructor() {
    super()
    this.debugName = 'Tutorial'
  }

  protected recompute(): void {}
  renderSelf(_ctx: Ctx2D): void {}
}
