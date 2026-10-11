# MonoLith

A standalone Windows CAD program for engineering parts and architectural plans. Part modeling follows the SolidWorks/Inventor workflow (sketch → constrain → feature → history). Plan drafting follows the AutoCAD workflow (command line, object snaps, grips, layers).

## Run it

Unzip `MonoLith-0.1.0-win.zip` anywhere and start `MonoLith.exe`. There is no installer, and it works offline.

## Part documents (`.lithprt`)

**Sketching**

1. Select Front, Top or Right Plane in the FeatureManager tree, or click a planar face.
2. Open the **Sketch** tab and click **Sketch**. The view turns normal to the plane.
3. Draw with Line (L), Centerline, Corner/Center Rectangle (R), Circle (C), Centerpoint Arc (A), 3‑Point Arc, Tangent Arc, Straight Slot and Point.
   - Relations are added automatically when you snap: coincident, midpoint, on‑edge, horizontal and vertical.
4. **Smart Dimension (D)**: click an entity, or two entities, then click to place the dimension and type its value.
   - Where you place the dimension decides whether it is horizontal, vertical or aligned.
   - A dimension that would over‑define the sketch becomes a driven (reference) dimension.
5. Select entities to see their properties and to add relations: horizontal, vertical, parallel, perpendicular, equal, tangent, concentric, collinear, midpoint, symmetric or fix.
6. **Text (X)**: click to place sketch text, then type it and set the font, height (capital letter height in mm), rotation and alignment in the left panel. Any installed Windows font can be used, and DejaVu Sans is bundled as a fallback. Text outlines act as sketch profiles: Extruded Boss embosses the text and Extruded Cut engraves it. Drag the text to move it, or dimension and relate its anchor point.
7. **Trim Entities (T)**, **Convert Entities** (project model edges into the sketch) and **Construction Geometry** are also on the Sketch tab.
8. The status bar shows **Under / Fully / Over Defined**. Under‑defined geometry is blue and fully defined geometry is black. Drag geometry to see how it is constrained.
9. To finish, click the confirmation corner (top right) or **Exit Sketch**.

**Features** (Features tab)

| Feature | Options |
|---|---|
| Extruded Boss/Base, Extruded Cut | Blind, Through All, Mid Plane; reverse direction |
| Revolved Boss, Revolved Cut | Axis from a sketch line or centerline, or the X/Y/Z axis; any angle |
| Fillet, Chamfer | Pick edges |
| Shell | Pick the faces to remove |
| Linear Pattern, Circular Pattern, Mirror | Pattern or mirror earlier extrude/revolve features |

Every feature opens a PropertyManager with a live preview. Accept with ✓ or Enter, cancel with ✗ or Esc.

**History**

- Double‑click a feature to edit it, or right‑click it to Edit Sketch, Suppress, Roll Back, Rename or Delete.
- Drag the blue rollback bar to roll the model back.
- Upstream edits rebuild downstream features. A sketch placed on a face moves with that face. Fillet, chamfer and shell edge/face references are re‑matched after changes, and a feature whose reference cannot be found shows ⚠ in the tree.

**Evaluate**

- Mass Properties, using the material set on the Material item in the tree.
- Measure: edge length and diameter, face area, and the distance or angle between two selections.

**View**

- Middle‑drag rotates, Ctrl+middle or right‑drag pans, and the wheel zooms at the cursor. Alt+left‑drag also rotates.
- Ctrl+1…7 gives the standard views, Ctrl+8 is Normal To and F is Zoom to Fit. The arrow keys rotate 15°.

## Plan documents (`.lithpln`)

Type commands directly in the window. Space or Enter repeats the last command.

| Group | Commands |
|---|---|
| Draw | LINE (L), PLINE (PL), RECTANG (REC), CIRCLE (C), ARC (A), TEXT (T), DIMLINEAR (DLI), DIMALIGNED (DAL), DIST (DI) |
| Modify | MOVE (M), COPY (CO), ROTATE (RO), SCALE (SC), MIRROR (MI), OFFSET (O), TRIM (TR), FILLET (F), EXPLODE (X), ERASE (E) |
| Architecture | WALL (W) with Thickness/Height/Justify options, DOOR, WINDOW, SLAB (turns a closed polyline into a floor slab) |

**Coordinate input**

| Input | Meaning |
|---|---|
| `x,y` | Absolute point |
| `@dx,dy` | Relative to the last point |
| `@dist<angle` | Polar, relative to the last point |
| A plain number | That distance along the cursor direction |

**Drafting aids and editing**

- Object snaps: endpoint, midpoint, center, quadrant, intersection and perpendicular.
- F3 object snap · F7 grid · F8 ortho · F9 grid snap.
- Selection works AutoCAD‑style: drag left→right for a window, right→left for a crossing, and Shift‑click removes an entity. Selected entities show grips you can drag.
- The left panel shows layers (visibility, lock, color, current) and the properties of the selection, all editable. Doors and windows can be flipped there.
- The **Architecture** tab switches between Plan, Plan + 3D and 3D. The 3D model updates live.

## Point clouds

Import laser scans as a reference in a Part or a Plan with **File → Import Point Cloud** (Ctrl+Shift+I) or the Import Point Cloud button. Opening a scan on its own starts a new Plan.

- **Formats:** LAS and LAZ (versions 1.0–1.4, all point formats), PLY (ASCII or binary), and XYZ/TXT/CSV/PTS text files. E57 is not supported yet; convert it to LAZ in CloudCompare first.
- **Import options:** file units (meters by default), moving the scan to the origin (recommended for georeferenced coordinates; the offset is stored), and the maximum number of points shown.
- **Display:** scan colors, elevation, intensity or a single color; adjustable point size.
- **Height section:** show only the points between two heights. **Floor plan slice** shows a 1.0–1.3 m band so walls, doors and windows stand out for tracing.
- **Plan snapping:** with OSNAP on, walls and lines snap to scan points ("Scan point"), within the height section.
- The scan file stays where it is. The document stores its path and display settings, and the scan reloads when the document is opened.

## File exchange

| Format | Import | Export |
|---|---|---|
| STEP (.step/.stp) | Into a Part (as an "Imported" feature) | Part, and the Plan's 3D model |
| IGES (.igs/.iges) | Into a Part | Part |
| DXF | Into a Plan, or into a sketch of a Part. Supports lines, polylines with bulges, arcs, circles, ellipses, splines, text/mtext, blocks (INSERT) and layers. | Plan (walls, doors and windows are exploded into geometry) or a sketch. Written as AutoCAD R12 DXF. |
| LAS / LAZ / PLY / XYZ / PTS | As a point-cloud reference in Parts and Plans | – |
| DWG | Through the free ODA File Converter | Through the free ODA File Converter |

DWG is a closed format. MonoLith converts it with the free **ODA File Converter** from opendesign.com. Install it in its default location under `C:\Program Files\ODA\` and DWG import/export works automatically. DXF works without it.

## Architecture

```
main/        Electron main process: windows, menus, file dialogs, DWG via ODA, kernel worker host
kernel/      Geometry kernel (OpenCascade 7.6 via opencascade.js WASM) in a worker thread:
             feature regeneration with a prefix cache, B-rep booleans, fillet/chamfer/shell,
             patterns, tessellation, STEP/IGES read/write, plan → 3D building model
shared/      Sketch profile extraction (closed loops, nested regions), shared by UI and kernel
renderer/src/
  viewport.js      three.js orthographic CAD viewport, SolidWorks-style navigation, view triad
  sketch/          PlaneGCS (FreeCAD's 2D constraint solver, WASM) wrapper + interactive sketcher
  part/part.js     FeatureManager tree, PropertyManager features, rollback, picking, evaluate
  plan/            AutoCAD-style drafting engine, architecture objects, command set
  io/dxf.js        DXF reader (dxf-parser) and R12 writer
```

Documents are plain JSON. A part stores its full parametric feature history, and sketches store their geometry together with their constraints.

## Build from source

Requires Node.js 20 or newer.

```
npm install
npm start                 # build the renderer bundle and run in development
npm run dist              # Windows x64 portable zip in release/
npm run test:kernel       # geometry kernel tests (Node, no UI)
```

## Licenses of bundled components

- Electron (MIT)
- three.js (MIT)
- opencascade.js / OpenCascade Technology (LGPL‑2.1)
- @salusoft89/planegcs, from FreeCAD's PlaneGCS (LGPL‑2.1)
- dxf-parser (MIT)
- opentype.js (MIT)
- laz-perf (Apache-2.0)
- DejaVu fonts (Bitstream Vera / DejaVu license, see renderer/fonts/DejaVu-LICENSE.txt)
