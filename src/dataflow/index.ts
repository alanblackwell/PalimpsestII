// src/dataflow — public API
//
// The dataflow engine has three parts:
//
//   Graph     — dependency registry, cycle detection, bind/unbind helpers.
//   Clock     — continuously advancing time source (driven by Evaluator).
//   Evaluator — requestAnimationFrame loop, ticks Clock, composites stack.
//
// Typical setup:
//
//   import { graph, Clock, Evaluator } from '../dataflow/index.js'
//
//   const evaluator = new Evaluator(canvas)
//   const clock     = new Clock()
//   evaluator.setClock(clock)
//   evaluator.setStack(rootLayer)
//   // → runs continuously, re-evaluating dirty nodes each frame.
//
//   // To bind a source layer to a parameter slot:
//   const ok = graph.bind(sourceLayer, myLayer.someSlot)
//   // → false if types mismatch or would create a cycle.

export { Graph, graph } from './Graph.js'
export { Clock }        from './Clock.js'
export { Evaluator }    from './Evaluator.js'
