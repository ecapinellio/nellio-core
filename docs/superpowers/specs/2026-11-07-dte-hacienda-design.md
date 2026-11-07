# DTE a Hacienda al entregar el pedido (fase 4) — investigación, decisiones y plan

Fecha: 2026-11-07 · Estado: construido, sin verificar contra `apitest` (rama `feat/dte-hacienda`) ·
Caso base: ECTEC · Registra ADR-015 · Sigue a
[2026-11-04-order-fulfillment-e2e-design.md](2026-11-04-order-fulfillment-e2e-design.md) §12

Convención: **[Verificado]** = leído en un documento oficial de Hacienda.
**[Sin verificar]** = no se pudo leer en la fuente oficial; hay que confirmarlo
en el ambiente de pruebas (`apitest`) antes de producción.

---

## 1. Contexto

Al entregar un pedido, `record_delivery()` y `correct_order_status()` pasan
`orders.invoice_status` a `pending`. Hasta hoy nada lo factura. Hacienda exige
que cada venta tenga un Documento Tributario Electrónico (DTE). El emisor
genera un JSON, lo firma y lo transmite a Hacienda. Hacienda devuelve un
**sello de recepción**. Después el emisor entrega al cliente el archivo JSON y
su **representación gráfica**.

Objetivo de esta fase:
1. Completar los datos fiscales que faltan en `tenants` (emisor) y `customers` (receptor).
2. Emitir el DTE solo, en segundo plano, cuando el pedido pasa a entregado.
3. Que cada empresa cliente de Nellio configure sus propias credenciales de Hacienda.

## 2. Investigación (fuentes oficiales)

### 2.1 Fuentes usadas

| Documento | Origen | Cómo se leyó |
|---|---|---|
| JSON Schemas (zip), actualizado 2026-08-11 | [factura.gob.sv → Información técnica](https://factura.gob.sv/informacion-tecnica-y-funcional/) | Descomprimido y leído campo por campo |
| Catálogos del Sistema de Facturación v1.2 (Excel) | misma página | Leído completo |
| Manual Funcional del Sistema de Transmisión **V2.0** (actualizado 2026-05-25) | misma página | Texto extraído |
| Manual Técnico para la Integración (actualizado 2026-05-25) | misma página | PDF sin texto legible; solo se sacaron los **links** que trae |
| Normativa de Cumplimiento DTE V2.0 (actualizada 2026-05-25) | misma página | PDF escaneado; **no se pudo leer** |
| "¿Cómo convertirse en Emisor de DTE?" | [factura.gob.sv/2020/09/02/ent1](https://factura.gob.sv/2020/09/02/ent1/) | HTML |
| Guía rápida para emitir Factura | [mh.gob.sv (PDF)](https://www.mh.gob.sv/wp-content/uploads/2023/10/Guia-rápida-emitir-una-Factura-en-la-plataforma-Sistema-de-Facturación.pdf) | Resumen |
| Reforma al Código Tributario (D.O. 175, 2022-09-20) | [factura.gob.sv/normativa](https://factura.gob.sv/normativa/) | Referencia |

Esquemas del zip que importan: `v2/fe-f-v2.json` (Factura, `tipoDte 01`,
`version 2`), `v4/fe-ccf-v4.json` (Crédito Fiscal, `tipoDte 03`, `version 4`),
`v3/invalidacion-schema-v3.json` (evento de invalidación, `version 3`),
`v4/contingencia-schema-v4.json`.

### 2.2 Cómo una empresa queda autorizada como emisor [Verificado, página ent1]

Hay dos plataformas:
- **Sistema de Facturación**: la app gratis de Hacienda, para quienes emiten pocos documentos.
- **Sistema de Transmisión**: integración por API desde un sistema propio. **Es la que usa Nellio.**

1. Pedir el ingreso en factura.gob.sv → "Solicitud de Ingreso" con NIT/DUI y la clave de Servicios en Línea de la DGII. Elegir **Transmisión**.
2. En el **Ambiente para Pruebas**, generar el **certificado de firma** (clave pública y privada) y la **contraseña API**. Las credenciales de prueba de Transmisión duran **2 meses**.
3. Hacer las **pruebas mínimas** de cada tipo de DTE que se vaya a usar, más los eventos de **Invalidación** y **Contingencia** (este último es obligatorio en Transmisión). Los DTE de prueba no tienen validez fiscal.
4. "Solicitar Autorización". Pide un correo vigente, al que llega un link de verificación.
5. En el **Ambiente Productivo**, generar el certificado y la contraseña API definitivos.
6. Emitir. Al cliente se le entrega la **Representación Gráfica** y el **archivo DTE (JSON)**.

El certificado lo da Hacienda y la transmisión es gratis. Para saber la fecha en que una empresa queda obligada: [factura.gob.sv/conozca-fecha-para-ser-emisor](https://factura.gob.sv/conozca-fecha-para-ser-emisor/), consultando con su NIT.

### 2.3 Datos del emisor (`emisor`) [Verificado, fe-f-v2 y fe-ccf-v4]

Los campos son los mismos en Factura y CCF. Todos son *required*: tienen que aparecer en el JSON aunque su valor pueda ser `null`.

| Campo | Contenido | Regla |
|---|---|---|
| `nit` | NIT | string, hasta 14 (sin guiones) |
| `nrc` | NRC | 2–8 caracteres |
| `nombre` | Razón social legal | 1–250 |
| `codActividad` | Código de actividad (CAT-019) | 5–6 |
| `descActividad` | Descripción de la actividad | 5–150 |
| `nombreComercial` | Nombre comercial | 1–150 o `null` |
| `direccion.departamento` | CAT-012 | código de 2 dígitos |
| `direccion.municipio` | CAT-013 | código de 2 dígitos |
| `direccion.distrito` | CAT-008 | código de 2 dígitos |
| `direccion.complemento` | Dirección en texto | 1–200 |
| `telefono` | | 8–30 |
| `correo` | | 6–100 |
| `codEstable` | Código del establecimiento (del contribuyente) | 4 o `null` |
| `codPuntoVenta` | Código del punto de venta (del contribuyente) | 1–15 o `null` |

**Cambio de la versión 2026:**
- Se agregó `direccion.distrito`, por la reforma municipal de 2024 (44 municipios y 262 distritos).
- Factura y CCF **ya no** llevan `tipoEstablecimiento`, `codEstableMH` ni `codPuntoVentaMH`. Esos campos todavía aparecen en blogs y versiones viejas.
- El evento de **invalidación sí** sigue pidiendo `codEstableMH` y `codPuntoVentaMH` (4 caracteres cada uno), además de `codEstable` y `codPuntoVenta`.

### 2.4 Datos del cliente (`receptor`) [Verificado]

- **Factura (01):** el bloque `receptor` completo puede ir `null` (consumidor final). Si va lleno: `tipoDocumento` (CAT-022: `36` NIT, `13` DUI, `03` pasaporte, `02` carnet de residente, `37` otro), `numDocumento` (1–20), `nrc`, `nombre`, `codActividad`, `descActividad`, `direccion`, `telefono`, `correo`. Cualquiera de ellos puede ser `null`.
- **CCF (03):** obligatorios con valor: `nit`, `nombre`, `codActividad`, `descActividad` y `direccion` completa (con distrito). Pueden ir `null` (pero el campo tiene que estar): `nrc`, `nombreComercial`, `telefono`, `correo`.

### 2.5 Identificación del documento [Verificado]

- `version`: Factura `2`, CCF `4`. `ambiente`: `00` pruebas, `01` producción. `tipoMoneda`: `USD`.
- `codigoGeneracion`: UUID en **mayúsculas** (36 caracteres).
- `tipoModelo`: 1 = previo, 2 = diferido. `tipoOperacion`: 1 = normal, 2 = contingencia. `tipoContingencia`/`motivoContin` van `null` en operación normal.
- `fecEmi` (fecha) y `horEmi` (`HH:MM:SS`).
- `numeroControl`: 31 caracteres, `DTE-{tipo}-{establecimiento 4}{punto de venta 4}-{correlativo 15}`, por ejemplo `DTE-01-M001P001-000000000000001`.
  - El establecimiento es `M`/`B`/`S`/`P` + 3 dígitos (Matriz, Bodega, Sucursal, Predio/Patio).
  - El punto de venta es `P` + 3 dígitos.
  - El correlativo es secuencial y "no debe repetirse en un año calendario" (Manual Funcional V2.0, sección XI).

### 2.6 Cuerpo, resumen e IVA [Verificado]

- **Líneas (`cuerpoDocumento`):** `numItem`, `tipoItem` (CAT-011: 1 = bienes), `cantidad`, `uniMedida` (CAT-014), `descripcion`, `precioUni`, `montoDescu`, `ventaNoSuj`, `ventaExenta`, `ventaGravada`, `tributos`, `psv`, `noGravado`. En Factura además va `ivaItem`. Los montos de línea admiten hasta 8 decimales.
- **Resumen:** montos con **2 decimales** (`multipleOf 0.01`). Incluye `totalLetras`, `condicionOperacion` (CAT-016: 1 contado, 2 crédito, 3 otro) y `pagos` (CAT-017).
- **Precio unitario** (Manual Funcional): en **Factura** va **con IVA**; en **CCF** va **sin IVA**.
  - En Factura el IVA va adentro de cada línea (`ivaItem`) y en `totalIva`.
  - En CCF las líneas llevan `tributos: ["20"]` y el resumen lleva `tributos: [{codigo:"20", descripcion:"Impuesto al Valor Agregado 13%", valor}]`.
- Catálogos que se usan:
  - Unidades (CAT-014): Tonelada `30`, Kilogramo `34`, Libra `36`, Litro `23`, Galón `22`, Unidad `59`, Otra `99`.
  - Formas de pago (CAT-017): `01` efectivo, `04` cheque, `05` transferencia/depósito.
  - Tributo IVA 13% (CAT-015): `20`.
  - Motivos de invalidación (CAT-024): 1 error en la información, 2 rescindir la operación, 3 otro.

### 2.7 Transmisión

Endpoints sacados de los links del Manual Técnico [Verificado que existen].
Pruebas: `https://apitest.dtes.mh.gob.sv`. Producción: `https://api.dtes.mh.gob.sv`.

| Ruta | Para qué |
|---|---|
| `/seguridad/auth` | Autenticarse (NIT + contraseña API) y obtener un token |
| `/fesv/recepciondte` | Enviar un DTE |
| `/fesv/recepcionlote/` | Enviar un lote |
| `/fesv/recepcion/consultadte/` | Consultar un DTE |
| `/fesv/recepcion/consultadtelote/{codigoLote}` | Consultar un lote |
| `/fesv/anulardte` | Evento de invalidación |
| `/fesv/contingencia` | Evento de contingencia |

- **Firmador:** Hacienda distribuye uno en Docker (`http://localhost:8113/firmardocumento/`).
- **Consulta pública** (para el QR de la representación gráfica): `https://webapp.dtes.mh.gob.sv/consultaPublica?ambiente={ambiente}&codGen={codigoGeneracion}&fechaEmi={fecEmi}`.

**[Sin verificar]** No se pudo leer en el Manual Técnico; sale del conocimiento público del firmador oficial y de integraciones existentes:
- `auth`: `POST` form-urlencoded `user=<NIT>&pwd=<contraseña API>`, que responde `{status:"OK", body:{token:"Bearer …"}}`.
- `recepciondte`: `POST` JSON `{ambiente, idEnvio, version, tipoDte, documento: <JWS>, codigoGeneracion}` con header `Authorization: <token>`. Responde `{estado:"PROCESADO"|"RECHAZADO", selloRecibido, fhProcesamiento, codigoMsg, descripcionMsg, observaciones[]}`.
- Firma: JWS compacto con **RS512** sobre el JSON.
- El certificado `.crt` es un XML con `<privateKey><encodied>` (PKCS#8 en base64) y `<clave>` (SHA-512 de la contraseña de la clave privada).

### 2.8 Invalidación y contingencia [Verificado, Manual Funcional V2.0]

- **Invalidación:**
  - Es un evento firmado; va **uno por DTE**.
  - Con los tipos 1 y 3, primero se emite y sella el documento que reemplaza al invalidado.
  - Con el tipo 2 (rescindir) solo se referencia el `codigoGeneracion` original.
  - Plazos: Factura (FE), Factura de Exportación (FEXE) y Factura de Sujeto Excluido (FSEE) tienen hasta **3 meses** desde la transmisión. CCF y la mayoría de los demás tienen **10 días hábiles**.
  - Fuera de plazo Hacienda no da sello.
- **Contingencia:** si no se puede transmitir, el emisor sigue la política de reintentos. Al volver la conexión envía el **evento de contingencia** (plazo máximo de **24 h** desde que terminó la falla) y luego todos los documentos de ese periodo.

## 3. Decisiones

| # | Decisión | Por qué | Quién |
|---|---|---|---|
| D1 | Se factura **al entregar**: el pedido pasa a la categoría `delivered` (entregado o parcial). Responde la pregunta 9 del spec de fulfillment. | Así lo pidió Emilio. Un parcial factura solo lo entregado y evita notas de crédito. | Emilio |
| D2 | El **tipo de documento sale del cliente**: con NRC → **CCF (03)**; sin NRC → **Factura (01)**. | Es la regla habitual: el contribuyente inscrito necesita el CCF para su crédito fiscal. | Emilio |
| D3 | **"Los precios incluyen IVA" es un interruptor por empresa**, apagado por defecto. | No se sabe si el `price_per_unit` de ECTEC trae IVA. **Pendiente confirmar con el contador de ECTEC.** | Emilio |
| D4 | **Credenciales en Supabase Vault**. El admin las sube en `/admin/company`. Solo `service_role` las lee; el navegador nunca las ve. | Escala a muchas empresas sin tocar Vercel. Es la misma regla que la clave `service_role` (CLAUDE.md §7). | Emilio |
| D5 | **Cola + cron** (`dte_documents` + `/api/cron/dte` cada 5 min), el mismo patrón que ADR-013. | Facturar nunca bloquea ni deshace una entrega (anti-objetivo §2 del spec de fulfillment). Las transiciones vienen del navegador; no hay un servidor propio donde hacerlo después. | Claude |
| D6 | **Se firma en Node** (`node:crypto`, RS512), no con el firmador Docker de Hacienda. | Docker no corre en Vercel y el JWS cabe en pocas líneas sin dependencias. | Claude |
| D7 | Cada DTE **guarda su `numeroControl` y su `codigoGeneracion` para siempre**, también al reintentar. Antes de reenviar un documento que ya tuvo un intento, se **consulta** a Hacienda. | Evita emitir dos veces una factura cuya respuesta se perdió. Si se cae la red, el número no cambia. | Claude |
| D8 | El correlativo es **por empresa y por tipo de documento** (`dte_sequences`) y nunca se reinicia. Un rechazo puede dejar un hueco. | El manual pide secuencial y sin repetir en el año. Con un contador atómico no se pueden repetir números. | Claude |
| D9 | La **dirección se guarda como códigos** (departamento, municipio, distrito) más `address` como complemento. El `tipoDocumento` del cliente sale del `tax_id` (14 dígitos → NIT `36`, 9 → DUI `13`), y `nombreComercial` es `customers.name`. | Se guarda solo lo que no se puede deducir. | Claude |
| D10 | `tenants` sigue **sin GRANT de UPDATE**. El admin edita con `save_company_fiscal()` (security definer, tenant tomado del JWT). | ADR-002: el `tenant_id` nunca viene del input. | Claude |
| D11 | **Activar el DTE** exige datos fiscales completos y credenciales cargadas. | Si no, la cola solo se llenaría de errores. | Claude |
| D12 | **Representación gráfica**: página HTML imprimible en `/t/[token]/factura` (reusa `tracking_token`), con QR a la consulta pública, sin caducidad. El correo al cliente adjunta el **JSON**. El PDF se obtiene con "Imprimir → Guardar PDF". Nueva dependencia: `qrcode`. | Entregar JSON y representación gráfica al cliente es obligatorio. Un generador de PDF en el servidor es más pesado de lo que hace falta ahora. | Claude |
| D13 | **Invalidación tipo 2 (rescindir)**: la hace el admin desde el detalle del pedido, en el momento. Después se puede volver a emitir con "Reintentar". | Es parte de las pruebas mínimas para obtener la autorización. | Claude |
| D14 | Los **errores de datos** (por ejemplo, "Al cliente le falta el distrito") dejan el DTE en `error` con un mensaje en español. Hay un botón **Reintentar** (operador y admin). | El operador lo arregla sin ayuda técnica. | Claude |

## 4. ADR-015 (va a CLAUDE.md §5)

**ADR-015: DTE por cola + cron, firma en Node, credenciales en Vault; se factura al entregar.**

**Decisión:**
- Cuando `orders.invoice_status` pasa a `pending` y la empresa tiene `dte_enabled`, un trigger inserta una fila `queued` en `dte_documents`, en la misma transacción.
- El cron `/api/cron/dte` (cada 5 min, `CRON_SECRET`) arma el JSON en TypeScript, asigna `numeroControl` y `codigoGeneracion` una sola vez (`assign_dte_number()`), firma con RS512 usando el certificado guardado en Vault y transmite a Hacienda.
- `finish_dte()` guarda el resultado, el `invoice_status` del pedido y el evento `invoice` en una sola transacción.

**Por qué:** igual que ADR-013, un fallo de Hacienda nunca puede bloquear ni deshacer una entrega. Además Vercel no corre el firmador Docker de Hacienda.

**Consecuencias:**
- Las credenciales solo se leen con `get_dte_credentials()` (service_role).
- `authenticated` solo lee `dte_documents` (operador y admin).
- Los números no cambian al reintentar, y antes de reenviar se consulta a Hacienda.
- Sin `dte_enabled` no se encola nada.
- El tipo (01/03) depende del NRC del cliente.
- Contingencia, lotes, retenciones de IVA y notas de crédito quedan pendientes.

## 5. Plan de implementación

### 5.1 Migración `supabase/migrations/20261108100000_dte.sql`

- **`tenants`, columnas nuevas:**
  - `legal_name`
  - `department_code` / `municipality_code` / `district_code` (2 dígitos)
  - `establishment_code` (default `M001`, `^[MBSP][0-9]{3}$`)
  - `pos_code` (default `P001`, `^P[0-9]{3}$`)
  - `mh_establishment_code` / `mh_pos_code` (4 caracteres)
  - `prices_include_vat` (default false)
  - `dte_environment` (`00`/`01`, default `00`)
  - `dte_enabled` (default false)
  - Checks de formato: NIT/NRC canónicos, actividad de 5–6 dígitos, largos según el esquema.
- **`customers`:** `department_code` / `municipality_code` / `district_code`. Se agregan a `save_customers()` (solo actualiza las claves presentes).
- **Credenciales:** tabla `tenant_dte_credentials` (ids de secretos de Vault, con RLS y sin grants) y estas funciones:
  - `set_dte_credentials(cert, key_password, api_password)`: solo admin; un `null` conserva el valor guardado.
  - `dte_credentials_status()`: solo dice si están configuradas.
  - `get_dte_credentials(tenant)`: solo service_role.
- **`save_company_fiscal(jsonb)`:** admin; valida y canoniza; bloquea `dte_enabled` si faltan datos o credenciales.
- **`dte_documents`:** estado (`queued`/`issued`/`rejected`/`error`/`invalidated`), tipo, ambiente, número de control, código de generación, `document` (JSON sin firmar), sello, respuesta, intentos, `next_attempt_at`, datos de invalidación.
  - Índices únicos: `(tenant_id, control_number)`, `generation_code`, y "un DTE vivo por pedido" (`queued`/`issued`).
  - RLS de lectura para operador y admin.
- **`dte_sequences`** + `assign_dte_number(doc, tipo)`: idempotente; si cambia el tipo, toma un número del tipo nuevo.
- **Funciones de la cola** (service_role): `claim_dte_documents(limit)`, `finish_dte(...)`, `mark_dte_invalidated(...)`.
- **`order_events.action`** acepta el valor nuevo `invoice`.
- **Trigger `orders_enqueue_dte`:** encola al pasar a `pending`; borra la fila no enviada si una corrección del admin lo devuelve a `not_invoiced`. Se traga sus propios errores.
- **`retry_dte(order_id)`** (operador y admin): vuelve a encolar un `rejected`/`error` con los mismos números, o crea una fila nueva después de una invalidación.
- **Correo:** el tipo de correo `invoice_issued` se manda siempre que el cliente tenga correo, sin depender de `customer_email_actions`, porque entregar el DTE es obligatorio.
- **`get_order_invoice(token)`** para `anon`, que alimenta la página de la representación gráfica.

### 5.2 TypeScript `lib/dte/`

- `catalogs.ts`: departamentos (14), municipios (44, cada uno con su departamento), distritos (262, por departamento), unidades y formas de pago.
- `build.ts`: `buildDte()` puro. Devuelve el JSON o una lista de problemas en español. Reglas:
  - IVA según el tipo de documento y `prices_include_vat`;
  - cantidad `delivered_quantity ?? quantity`;
  - precio `price_at_order`;
  - redondeo a 8 decimales en las líneas y 2 en el resumen;
  - NIT y NRC sin guiones, DUI con guion;
  - `condicionOperacion` 2 si el cobro es a crédito.
- `letters.ts`: `totalLetras`.
- `sign.ts`: lee el `.crt`, comprueba la clave y firma en JWS RS512.
- `hacienda.ts`: `auth`, `send`, `consult`, `invalidate`. Es lo único que depende del formato sin verificar (§2.7).
- `process.ts`: `processPendingDtes(admin)`, el ciclo de la cola. Hasta 5 intentos con espera de 15 min.
- `app/api/cron/dte/route.ts` + `vercel.json`.

### 5.3 Pantallas (siguiendo `DESIGN.md`)

- **`/admin/company`:** datos fiscales con selects en cascada de ubicación, interruptores (IVA, ambiente, activar DTE) y credenciales (solo muestra "configuradas").
- **Clientes:** los 3 selects de ubicación en el panel fiscal.
- **Detalle del pedido:** bloque "Factura" (estado, número de control, sello, error u observaciones, link a la representación gráfica) con botones **Reintentar** e **Invalidar** (admin).
- **`/t/[token]/factura`:** representación gráfica imprimible con QR.

### 5.4 Tests

- **`tests/dte-lib.test.ts`:**
  - `buildDte` para Factura y CCF, con y sin IVA, parciales y datos faltantes, **validado contra los esquemas oficiales** (`ajv` como devDependency, esquemas copiados en `tests/fixtures/dte-schemas/`);
  - `totalLetras`;
  - firma y verificación con un `.crt` de prueba.
- **`tests/dte.test.ts`:**
  - encolar y no encolar (DTE desactivado);
  - correlativo sin repetidos en paralelo;
  - reintento con los mismos números;
  - RLS (chofer, otra empresa);
  - credenciales solo de admin y nunca legibles por `authenticated`;
  - `processPendingDtes` con un `fetch` falso (PROCESADO, RECHAZADO, red caída);
  - `save_company_fiscal` y `save_customers`.

### 5.5 Docs al terminar

- CLAUDE.md: ADR-015; §4 (tablas nuevas, quitar "Tabla `dte`" de pendientes); §8 (cobertura nueva).
- TODOS.md: fase 4 hecha y los pendientes de §6.

## 6. Fuera de esta entrega

| Tema | Por qué queda afuera |
|---|---|
| Evento de contingencia y envío por lote | Es obligatorio en las pruebas mínimas, pero primero ECTEC necesita acceso a `apitest`. Es el **siguiente paso**. |
| Retención y percepción de IVA (`ivaRete1`/`ivaPerci1`) para grandes contribuyentes | Va en 0 hasta que el contador de ECTEC confirme si aplica. |
| Notas de crédito/débito, exportación, sujeto excluido | No hay caso de uso todavía. |
| Validar que el distrito pertenezca al municipio | El catálogo oficial es plano y no trae esa relación. Se filtra por departamento y Hacienda valida al recibir. |
| PDF generado en el servidor | Con "Imprimir → Guardar PDF" alcanza por ahora (D12). |

## 7. Riesgos y qué verificar en `apitest`

1. El formato de petición y respuesta de `auth`, `recepciondte`, `consultadte` y `anulardte` (§2.7, sin verificar). Está aislado en `lib/dte/hacienda.ts`.
2. El formato XML del `.crt` y la regla de la clave privada (`lib/dte/sign.ts`).
3. Si Hacienda acepta un `fecEmi` de un día anterior al reintentar, o si hay que reconstruir el documento.
4. Si un hueco en el correlativo (por un rechazo) le genera observaciones a Hacienda.
5. El cronograma de la versión 2.0 (un blog dice que es obligatoria el 2026-12-01). Hay que confirmarlo en la Normativa oficial.

## 8. Preguntas abiertas para ECTEC

1. ¿El `price_per_unit` del catálogo incluye IVA? (D3)
2. ¿ECTEC ya está autorizada como emisor DTE? ¿En Facturación o en Transmisión? ¿Tiene credenciales de prueba?
3. NIT, NRC, razón social, actividad económica, dirección (departamento, municipio, distrito) y los códigos de establecimiento y punto de venta (los suyos y los que asignó Hacienda).
4. ¿Algún cliente le retiene el 1% de IVA (gran contribuyente)?
5. ¿Hay ventas exentas o no sujetas, o todo es gravado al 13%?

## 9. Verificación final

1. `supabase db reset` → `pnpm test` → `pnpm lint` / `tsc`.
2. Prueba manual: llenar `/admin/company` → entregar un pedido de un cliente con NRC → `curl -H "Authorization: Bearer $CRON_SECRET" localhost:3000/api/cron/dte` → revisar el bloque Factura y `/t/<token>/factura`.
3. Con las credenciales de prueba de ECTEC: emitir en `apitest` y confirmar el sello en la consulta pública de Hacienda.
