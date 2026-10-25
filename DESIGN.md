# Design System — Nellio Core

## Product Context
- **What this is:** SaaS interno de gestión de pedidos y operaciones de distribución.
- **Who it's for:** Alejandra (operaciones, usuaria principal — transcribe pedidos de WhatsApp), Milo (dueño, comprador económico), y eventualmente drivers.
- **Space/industry:** Herramienta operativa B2B, no consumer-facing. Piloto: ECTEC, distribuidor químico en El Salvador.
- **Project type:** Web app / dashboard interno.
- **Memorable thing:** "Esto es claro, nunca me pierdo" — el estado de cada pedido debe leerse de un vistazo, bajo presión de tiempo. Toda decisión de diseño sirve a esto.

## Aesthetic Direction
- **Direction:** Industrial/Utilitarian — función primero, paleta contenida, acentos monoespaciados en datos.
- **Decoration level:** Mínima — tipografía y espacio hacen el trabajo, sin adornos.
- **Mood:** Software de operaciones serio, no un prototipo. Preciso, plano, "manufacturado" — no genérico-SaaS ni bubbly.
- **Reference sites:** [linear.app](https://linear.app) (minimalismo denso construido sobre Radix), [ui.shadcn.com/examples/dashboard](https://ui.shadcn.com/examples/dashboard) (tablas con estado, sidebar).

## Component Library
- **shadcn/ui sobre Radix UI primitives + Tailwind CSS v4.** No son alternativas: shadcn/ui es Radix + estilos Tailwind + componentes copiados al repo (sin dependencia opaca). Ya hay Tailwind v4 instalado — cero fricción de adopción.
- `Command`/`Combobox` para búsqueda-con-quick-add de clientes/productos.
- `Dialog` para el diálogo de confirmación obligatoria de pedido duplicado (no un banner pasivo).

## Typography
- **Headings/UI/Body:** Geist Sans — ya está cargada en el template (`next/font`), cero costo de migración.
- **Data/Tables (todo número):** Geist Mono con `font-variant-numeric: tabular-nums` — IDs de pedido, cantidades, precios, timestamps, siempre alineados en columna. Es un dispositivo funcional, no decorativo: hace los números comparables de un vistazo.
- **Code:** Geist Mono.
- **Loading:** ya presente vía `next/font/google` en `app/layout.tsx` (`Geist`, `Geist_Mono`) — reutilizar, no reemplazar.
- **Scale:**
  | Rol | Tamaño / line-height | Peso |
  |---|---|---|
  | Hero / título de página | 34px / 40px | 600 |
  | H2 / sección | 20px / 28px | 600 |
  | H3 / panel | 15px / 22px | 600 |
  | Body / UI | 13-14px / 20-21px | 400-500 |
  | Label / meta | 11-12px / 16px | 500 |
  | Mono / datos | 12.5-14px / 20px | 400, tabular-nums |

## Color
- **Approach:** Balanceado — neutros + un acento + colores semánticos para el pipeline de estado del pedido.
- **Primary (accent):** `#0F766E` (hover `#115E59`) — teal técnico. No es el morado-gradiente típico de IA; conecta sutilmente con "Ecología Técnica" sin ser literal.
- **Neutrals:** escala zinc, `#fafafa` (zinc-50, bg claro) → `#09090b` (zinc-950, bg oscuro).
- **Semantic — estado del pedido (la pieza más importante del sistema):**
  | Estado | Color | Tint (fondo) |
  |---|---|---|
  | Pendiente | `#D97706` | `#FFFBEB` |
  | Confirmado | `#0284C7` | `#F0F9FF` |
  | Despachado | `#7C3AED` | `#F5F3FF` |
  | Entregado | `#059669` | `#ECFDF5` |
  | Duplicado / error | `#E11D48` | `#FFF1F2` |
- **Semantic — estado de cuenta de usuario** (`/admin/users`): Activo `#059669` (mismo verde que Entregado; dark `#34D399`) · Desactivado zinc-400 `#A1A1AA` (dark zinc-500 `#71717A`). Tokens `--user-active` / `--user-inactive`. Mismo badge que los pedidos (componente compartido `components/status-badge.tsx`); filas desactivadas en `text-muted-foreground` y al final de la lista.
- **Estilo de badge de estado:** borde izquierdo de 3px del color + punto + texto en negrita — NO un badge gris tenue. Debe leerse de reojo bajo presión de tiempo.
- **Dark mode:** No es solo invertir. Superficies rediseñadas: `bg` → zinc-950, `surface` → zinc-900, `surface-raised` → zinc-800, bordes en zinc-800/700. Semánticos aclarados ~15% para mantener contraste 4.5:1 sobre fondo oscuro (ej. pending `#D97706` → `#FBBF24`, accent `#0F766E` → `#2DD4BF`). Sigue la preferencia del sistema operativo (`prefers-color-scheme`) con override manual persistido (claro/oscuro/sistema).

## Spacing
- **Base unit:** 4px.
- **Density:** Comfortable — no compacta. Bajo presión de tiempo, más aire reduce errores de captura (referencia: eng-review plan, decisión 5 — "los banners se ignoran bajo presión de tiempo").
- **Scale:** 2xs(2) xs(4) sm(8) md(16) lg(24) xl(32) 2xl(48) 3xl(64)

## Layout
- **Approach:** Grid-disciplined — columnas estrictas, alineación predecible. Sirve directo al mandato de claridad.
- **Shell:** Sidebar fijo (208px) + topbar (52px) para vistas autenticadas. Bajo `md` (768px) el sidebar se oculta: botón ☰ en el topbar abre el mismo menú en un panel lateral (Sheet, desde la izquierda, filas de 44px); el usuario y el tenant van al pie del panel y "Cerrar sesión" queda como ícono. Login usa panel dividido: mitad oscura (zinc-900, fija — no depende del theme, funciona como firma de marca) + formulario minimalista.
- **Max content width:** 1280px en vistas de tabla/lista; 480-560px en formularios y diálogos.
- **Border radius:** sm 4px (inputs, badges) · md 6px (botones, cards) · lg 8px (paneles, diálogos) · full 9999px (avatar, punto de estado).
- **Shadows:** planas, sin gradientes ni sombras suaves grandes. `shadow-sm`/`shadow-md` sutiles para elevación de superficie; `shadow-lg` solo en modales/frames.

## Motion
- **Approach:** Mínimo-funcional — solo transiciones que ayudan a entender el cambio de estado (badges, apertura/cierre de diálogos, banner de fail-open del chequeo de duplicados).
- **Easing:** enter `ease-out` · exit `ease-in` · move `ease-in-out` (`cubic-bezier(0.16, 1, 0.3, 1)` como base).
- **Duration:** micro 100ms · short 150-200ms · medium 250ms. Sin animación decorativa — es una herramienta de uso diario, la decoración se vuelve fricción con el tiempo.

## Preview
Preview HTML generado y aprobado: `/private/tmp/claude-501/-Users-emiliocarbonell-Developer-git-nellio-core/f9c2ae61-0bb3-4ab0-82af-42239fd69010/scratchpad/nellio-design-preview.html` (tipografía, paleta, componentes, y mockups de login + captura de pedido + lista de pedidos).

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-07-24 | Sistema de diseño inicial creado | Creado vía `/design-consultation`, basado en CLAUDE.md + research de Linear/shadcn + feedback del usuario. Memorable thing: claridad de estado bajo presión de tiempo. |
| 2026-07-24 | shadcn/ui + Radix elegido sobre Radix "puro" | El usuario dudaba entre shadcn y Radix; son la misma pila en capas — shadcn da los patrones Combobox/Dialog que la pantalla de captura necesita, sin reinventar accesibilidad. |
| 2026-10-25 | Menú móvil: botón ☰ + panel lateral (no barra de pestañas abajo) | En 375px el sidebar fijo dejaba ~170px de contenido. El panel reusa el mismo menú y escala si se agregan secciones; una barra inferior solo admite 4-5. |
| 2026-10-24 | Estado de cuenta de usuario (Activo/Desactivado) reusa el badge de pedidos | `/plan-design-review` de RBAC Slice 3: el estado es lo que el admin escanea; mismo lenguaje visual que el resto de la app en vez de un badge nuevo. |
