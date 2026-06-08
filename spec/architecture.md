# PalimpsestII — Architecture Specification

## Overview

PalimpsestII is a reactive dataflow canvas application. Its core model is a
**directed dataflow graph** whose nodes are spatially ordered in a visible
stack. Each node holds a typed value, may depend on other nodes for its
inputs, and recomputes lazily when its dependencies change. The spatial
ordering (the stack) is simultaneously the user's mental model of execution
and the basis for automatic parameter inference.

The design is explicitly motivated by the spreadsheet calculation model:
cells are nodes, formulas are evaluation functions, cell references are
dependency edges, and recalculation propagates changes forward through the
graph. Unlike a spreadsheet, values are spatial and visual (images, masks,
paths, colours) as well as scalar.

---

## 1. Nodes and Values

Every entity in the system is a **Node**. A node has:

- A **type** — one value kind from a fixed vocabulary (see §3)
- A **current value** of that type
- A **spatial footprint** — a bounding rectangle on the canvas
- A **rendered appearance** — a bitmap cached from the last evaluation
- A **dirty flag** — set when any upstream dependency has changed

A node's value is computed by its **evaluation function** — a pure function
of its input values. When inputs change, the node is marked dirty. On the
next render pass, dirty nodes re-evaluate in dependency order.

---

## 2. The Layer Stack

Nodes are arranged in a **linear ordered stack**. The stack has a fixed
bottom (an empty background layer), and layers are inserted above it. The
stack order is the primary organisational structure visible to the user.

The stack serves two roles:

**Visual composition.** Rendering proceeds bottom-to-top. Each layer
composites its rendered output on top of all layers below it. A layer that
covers the full canvas and is opaque need not render further down.

**Automatic parameter inference.** When a new parameterised node is created,
it searches *downward* from its position for nodes whose types match its
parameter slots. Only layers already visible below the new layer are
candidates. This reflects the user's experience: you can only automatically
reference what is already there.

---

## 3. Value Types

| Type | Description | Example nodes |
|---|---|---|
| **Image** | A 2D RGBA bitmap | Photo, drawing, rendered shape |
| **Mask** | A single-channel opacity map | Painted mask, boundary shape |
| **Colour** | An RGBA colour value | Colour picker, colour sampler |
| **Amount** | A scalar in \[0, 1\] | Slider, proportion along path |
| **Direction** | A 2D vector (angle + magnitude) | Spinning vector, path tangent |
| **Point** | A 2D location | Draggable point, path position |
| **Rate** | A temporal frequency | Tempo layer |
| **Count** | A non-negative integer | Counter |
| **Event** | A discrete trigger | Button, timer pulse |
| **Collection** | An ordered set of node references | Layer group |

A node may satisfy **multiple types** simultaneously (e.g. a point sampler
may be both Image and Point). This is important for drag-to-bind: users can
connect nodes that satisfy the required type even indirectly.

**Type conversion** is explicit: conversion nodes exist for compatible pairs
(Point→Amount, Direction→Amount, Image→Colour, etc.). These are inserted
automatically when a drag-to-bind produces a compatible-but-not-identical
type match.

**Polymorphic types.** Some nodes have an output type that is not fixed but
is inferred from their inputs. The canonical example is a **Select** node:
given a boolean condition and two inputs of the same type T, it outputs a
value of type T. The output type is determined when the inputs are bound, not
declared in advance.

---

## 4. Parameters and Binding

A **parameterised node** declares one or more **parameter slots**, each
typed. The node's evaluation function reads from its bound parameters.

### Parameter slot states

| State | Meaning | Widget appearance |
|---|---|---|
| **Unbound** | No source; neutral default value | Interactive, draggable |
| **Bound(source)** | Actively receiving from source node | Static display of received value |
| **SuspendedBound(source)** | Source recorded but inactive | Interactive, draggable — as if Unbound |

### Binding modes

**Default binding** occurs at layer creation: the system searches downward
through the stack and automatically binds each parameter slot to the nearest
layer below whose type matches. If no match exists, the slot is left Unbound.

**Manual binding** is performed by drag-and-drop: the user drags any layer
from anywhere in the stack onto a parameter slot. Type matching and
conversion are applied as for default binding.

**Unbinding** removes the dependency and returns the slot to Unbound.

---

## 5. BindingLayers — Bindings as First-Class Stack Objects

When a manual binding is created, a **BindingLayer** is inserted into the
stack *above the consumer*. A BindingLayer is:

- A **value-producing node** in its own right — it exposes the source's
  value with the same type, so layers above it can bind to it and receive
  the same value the consumer is receiving
- A **visual representation** of the directed edge: it renders as a
  thumbnail of the source, a thumbnail of the consumer with the bound slot
  indicated, and a directed arrow between them
- An **interactive object**: clicking either thumbnail navigates to that
  layer; two controls are provided:
  - **Disable** — transitions the consumer's slot from Bound →
    SuspendedBound; the widget becomes interactive/draggable again; the
    arrow becomes a cross; the BindingLayer retains all state for re-enabling
  - **Remove** — unbinds the parameter entirely and removes the BindingLayer
    from the stack

The input binding (source → consumer slot) is established automatically when
the BindingLayer is created from the drag gesture.

Positioning the BindingLayer above the consumer means the entire dataflow
graph is inspectable by reading the stack: layers represent values, and
BindingLayers represent the directed edges between them.

---

## 6. Dataflow Evaluation

The dependency structure is a directed acyclic graph (DAG). Cycles are
prevented at bind time (not detected during propagation).

Evaluation uses **push invalidation with lazy pull**:

1. When a node's value changes, it pushes invalidation to all dependent
   nodes recursively, marking them dirty.
2. On each render frame, each visible layer pulls its value by calling
   `evaluate()`, which recursively evaluates dirty dependencies first
   (depth-first, equivalent to topological order).
3. A node's evaluated result is cached until marked dirty again.

Evaluation order is determined by the dependency graph, not by stack order.
Stack order governs *rendering* (compositing sequence) only.

---

## 7. Regions and Promotion

**Regions** are interactive UI elements that live spatially inside a layer.
They handle their own hit-testing and user interaction (dragging, clicking).

A region is a **sink only**: it can receive values via a bound parameter slot
(in which case its appearance is driven by the bound source), but it cannot
be used as a source for other nodes.

**Promotion** is the operation that converts a Region into a Layer. After
promotion, the region's value (e.g. the current position of a slider) is
available in the stack as a source for other layers to bind to. Promotion is
an explicit user gesture that makes a previously private widget value into a
named, reusable graph node.

---

## 8. Time and Animation

**Time** is a special source node with no inputs, whose value advances
continuously via `requestAnimationFrame`. It produces an Amount (a
normalised phase value).

An **AnimationPath** layer takes:
- An Amount input (position along the path, 0–1)
- A path geometry (sequence of control points)
- Produces a **Point** output

A **Rate** layer converts a time input and a Rate value into an Amount that
cycles continuously, allowing path-following to be driven at a controlled
tempo.

Because time is an ordinary node value, the same path layer can be driven
interactively (bound to a slider) or automatically (bound to a clock),
without any special-casing. Future external event sources (OSC, MIDI) would
be implemented as alternative source nodes for the Amount or Event types.

---

## 9. Collections

A **Collection** layer holds an ordered list of references to other nodes.
It satisfies the Collection type, and is used:

- As a visual container (renders its members composited in order)
- As a parameter source when a downstream layer expects a collection
  (e.g. a layout layer that positions its members)

Multi-value mapping (applying a parameterised layer to every collection
member) is intentionally not supported. Users compose operations on
individual layers.

---

## 10. Key Design Principles

1. **The stack is the mental model.** The ordering of layers in the stack
   corresponds directly to the user's understanding of what is constructed
   and how it executes.

2. **Bindings are visible.** Every edge in the dataflow graph appears as a
   BindingLayer in the stack. Nothing is hidden in the implementation.

3. **Directionality is strict.** All data flows from source to sink. There
   is no constraint solving or backpropagation.

4. **Default inference, explicit override.** The system infers bindings
   automatically at creation time (downward search by type). The user can
   always override or replace any binding by drag-and-drop.

5. **Promotion makes things explicit.** A region's value becomes part of the
   graph only when deliberately promoted to a layer. This keeps the stack
   uncluttered while making the promotion gesture meaningful.

6. **Time is not special.** Continuous animation is achieved by binding
   parameters to a clock source — the same mechanism as any other binding.
