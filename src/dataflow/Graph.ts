import { Node } from '../core/Node.js'
import { ParameterSlot } from '../core/ParameterSlot.js'

// ------------------------------------------------------------
// Graph — central registry with cycle detection and bind helpers
// ------------------------------------------------------------
// The Graph answers one critical question at bind time:
// "Would connecting source → consumer create a cycle?"
//
// The dependency edges run: source → consumer
// (source's value flows into consumer's parameter slot).
// A cycle would exist if source is already a transitive
// descendant of consumer — i.e. source is reachable from consumer
// by following dependent edges.
//
// Example cycle:  A → B → C → A  (A tries to use C as source,
// but C already depends on A via B).  Detected by BFS from consumer (A):
// A's dependents include B, B's include C, so source (C) is reachable → reject.

export class Graph {
  private readonly _nodes = new Set<Node>()

  // ----------------------------------------------------------
  // Node registry
  // ----------------------------------------------------------

  register(node: Node): void {
    this._nodes.add(node)
  }

  unregister(node: Node): void {
    this._nodes.delete(node)
  }

  get nodes(): ReadonlySet<Node> {
    return this._nodes
  }

  // ----------------------------------------------------------
  // Cycle detection
  // ----------------------------------------------------------

  // Returns true if binding source's output to a slot on consumer
  // is safe (would not create a cycle in the dependency graph).
  canBind(source: Node, consumer: Node): boolean {
    if (source === consumer) return false
    // A cycle would form if source is already reachable from consumer
    // via dependent edges (i.e. source is already downstream of consumer).
    // Adding source → consumer would then create: consumer → … → source → consumer.
    return !this.isReachable(consumer, source)
  }

  // BFS from `from` following dependent edges; returns true if `target` is found.
  private isReachable(from: Node, target: Node): boolean {
    const visited = new Set<Node>()
    const queue: Node[] = [from]
    while (queue.length > 0) {
      const node = queue.shift()!
      if (node === target) return true
      if (visited.has(node)) continue
      visited.add(node)
      for (const dep of node.dependents) {
        if (!visited.has(dep)) queue.push(dep)
      }
    }
    return false
  }

  // ----------------------------------------------------------
  // Bind / unbind helpers
  // ----------------------------------------------------------

  // Bind source's output to `slot`.
  // Returns true on success, false if the binding would create a cycle
  // or if source does not satisfy the slot's declared type.
  bind(source: Node, slot: ParameterSlot): boolean {
    // null type = polymorphic slot; skip the type check.
    if (slot.type !== null && !source.types.has(slot.type)) return false
    if (!this.canBind(source, slot.owner)) return false
    slot.bind(source)
    return true
  }

  // Suspend a binding (consumer acts as Unbound; source is remembered).
  suspend(slot: ParameterSlot): void {
    slot.suspend()
  }

  // Re-enable a suspended binding.
  resume(slot: ParameterSlot): void {
    slot.resume()
  }

  // Remove a binding entirely.
  unbind(slot: ParameterSlot): void {
    slot.unbind()
  }

  // ----------------------------------------------------------
  // Topological order
  // ----------------------------------------------------------

  // Returns all nodes reachable from `roots` in evaluation order
  // (sources before their dependents) via a post-order DFS.
  // Useful for batch evaluation or serialisation.
  topologicalOrder(roots: Iterable<Node>): Node[] {
    const visited  = new Set<Node>()
    const result: Node[] = []

    const visit = (node: Node): void => {
      if (visited.has(node)) return
      visited.add(node)
      // Visit all nodes this node depends on first.
      // We find them by checking which nodes list `node` as a dependent.
      // (Alternatively, nodes could maintain a `sources` set — consider
      // adding that if traversal becomes a bottleneck.)
      for (const candidate of this._nodes) {
        if (candidate.dependents.has(node)) visit(candidate)
      }
      result.push(node)
    }

    for (const root of roots) visit(root)
    return result
  }
}

// Singleton shared across the application.
export const graph = new Graph()
