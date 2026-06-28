import { ValueType, SlotState } from './types.js'
import type { Node } from './Node.js'

// ------------------------------------------------------------
// ParameterSlot — a typed input on a Layer or Region
// ------------------------------------------------------------

export class ParameterSlot {
  // null = polymorphic slot that accepts any source type.
  // Used by SelectLayer's value inputs.
  readonly type: ValueType | null

  readonly label: string

  // When true, this slot reads the source's cached value rather than
  // pulling a fresh evaluation.  The source is registered as a feedback
  // dependent (invisible to cycle detection), so cycles involving this
  // edge are permitted.  Used by EventLayer's image inputs so that the
  // event output can feed back into the same images being watched.
  readonly feedback: boolean

  private _state: SlotState = SlotState.Unbound
  private _source: Node | null = null

  // The owner is notified (marked dirty) whenever the source changes value.
  // Public so Graph can read it for cycle detection.
  readonly owner: Node

  constructor(type: ValueType | null, owner: Node, label?: string, feedback = false) {
    this.type     = type
    this.owner    = owner
    this.label    = label ?? ParameterSlot._defaultLabel(type)
    this.feedback = feedback
  }

  private static _defaultLabel(type: ValueType | null): string {
    if (type === null) return 'value'
    const m: Partial<Record<ValueType, string>> = {
      [ValueType.Amount]:    'amount',
      [ValueType.Colour]:    'colour',
      [ValueType.Image]:     'image',
      [ValueType.Mask]:      'mask',
      [ValueType.Point]:     'position',
      [ValueType.Direction]: 'direction',
      [ValueType.Rate]:      'rate',
      [ValueType.Count]:     'count',
      [ValueType.Event]:     'event',
      [ValueType.Collection]:'collection',
    }
    return m[type] ?? 'value'
  }

  get state(): SlotState { return this._state }
  get source(): Node | null { return this._source }

  // Bind to a source node. The source must satisfy this slot's type.
  bind(source: Node): void {
    this.unbind()
    this._source = source
    this._state  = SlotState.Bound
    if (this.feedback) source.addFeedbackDependent(this.owner)
    else               source.addDependent(this.owner)
    this.owner.markDirty()
  }

  // Suspend the binding: consumer acts as Unbound, but source is remembered.
  suspend(): void {
    if (this._state !== SlotState.Bound) return
    this._state = SlotState.SuspendedBound
    if (this.feedback) this._source!.removeFeedbackDependent(this.owner)
    else               this._source!.removeDependent(this.owner)
    this.owner.markDirty()
  }

  // Re-enable a suspended binding.
  resume(): void {
    if (this._state !== SlotState.SuspendedBound || this._source === null) return
    this._state = SlotState.Bound
    if (this.feedback) this._source.addFeedbackDependent(this.owner)
    else               this._source.addDependent(this.owner)
    this.owner.markDirty()
  }

  // Remove the binding entirely.
  unbind(): void {
    if (this._source !== null) {
      if (this.feedback) this._source.removeFeedbackDependent(this.owner)
      else               this._source.removeDependent(this.owner)
      this._source = null
    }
    this._state = SlotState.Unbound
    this.owner.markDirty()
  }

  get isActive(): boolean {
    return this._state === SlotState.Bound && this._source !== null
  }
}
