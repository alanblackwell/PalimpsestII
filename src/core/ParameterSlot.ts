import { ValueType, SlotState } from './types.js'
import type { Node } from './Node.js'

// ------------------------------------------------------------
// ParameterSlot — a typed input on a Layer or Region
// ------------------------------------------------------------

export class ParameterSlot {
  readonly type: ValueType

  private _state: SlotState = SlotState.Unbound
  private _source: Node | null = null

  // The owner is notified (marked dirty) whenever the source changes value.
  // Public so Graph can read it for cycle detection.
  readonly owner: Node

  constructor(type: ValueType, owner: Node) {
    this.type = type
    this.owner = owner
  }

  get state(): SlotState { return this._state }
  get source(): Node | null { return this._source }

  // Bind to a source node. The source must satisfy this slot's type.
  bind(source: Node): void {
    this.unbind()
    this._source = source
    this._state = SlotState.Bound
    source.addDependent(this.owner)
    this.owner.markDirty()
  }

  // Suspend the binding: consumer acts as Unbound, but source is remembered.
  suspend(): void {
    if (this._state !== SlotState.Bound) return
    this._state = SlotState.SuspendedBound
    this._source!.removeDependent(this.owner)
    this.owner.markDirty()
  }

  // Re-enable a suspended binding.
  resume(): void {
    if (this._state !== SlotState.SuspendedBound || this._source === null) return
    this._state = SlotState.Bound
    this._source.addDependent(this.owner)
    this.owner.markDirty()
  }

  // Remove the binding entirely.
  unbind(): void {
    if (this._source !== null) {
      this._source.removeDependent(this.owner)
      this._source = null
    }
    this._state = SlotState.Unbound
    this.owner.markDirty()
  }

  get isActive(): boolean {
    return this._state === SlotState.Bound && this._source !== null
  }
}
