<!--
Roadmap de Nellio — versión para clientes.

Cómo actualizarlo:
- Cada funcionalidad es un "###" dentro de su etapa. Para moverla de etapa,
  mueve el bloque completo.
- Etapas, en este orden: Disponible, En construcción, Próximo, Después, Explorando.
- Escribe para el cliente: qué gana su operación, no cómo está hecho.
  Nada de nombres de tablas, ADRs ni clientes por nombre.
- "Necesita" solo cuando una funcionalidad depende de otra o de datos que
  aún no hay; así queda claro por qué no está antes.
- Cambia la fecha de "Actualizado" en cada cambio.
- El detalle técnico va en TODOS.md y docs/superpowers/, no aquí.
-->

# Roadmap de Nellio

**Del mensaje de WhatsApp a la entrega firmada, y de ahí a anticipar el próximo pedido.**

Nellio ordena los pedidos que llegan desordenados y de último minuto. En vez de
pedirles a tus clientes que cambien cómo piden, tu equipo los recibe, los sigue
y los entrega con un proceso claro. Con el tiempo, Nellio usa ese historial para
avisarte qué viene antes de que llegue.

Actualizado: 2026-11-05

Etapas: **Disponible** → **En construcción** → **Próximo** → **Después** → **Explorando**

---

## Disponible

En uso hoy.

### Captura de pedidos en segundos
Pega el mensaje del cliente, busca cliente y producto aunque estén mal escritos
o sin tildes, y Nellio avisa si ese cliente ya tiene un pedido pendiente del
mismo día.

### Tablero de pedidos en vivo
Todo el equipo ve el mismo tablero al mismo tiempo, en computadora y en
celular. Si un compañero mueve un pedido, lo ves al instante.

### Detalle del pedido con precios protegidos
Cada pedido guarda el precio del momento en que se tomó. Si alguien cambia un
precio, queda registrado quién y cuándo.

### Catálogo de productos y clientes
Se carga pegando desde Excel. Incluye los datos fiscales de cada cliente (NIT,
NRC, giro), listos para la factura electrónica.

### Equipo y permisos
Administradores, operadores y choferes: cada uno ve solo lo que le toca. Se
crean y desactivan usuarios sin depender de nadie.

### Números del día para el dueño
Pedidos, pendientes, entregados y ventas del día, visibles solo para
administradores.

### Tus datos, aislados
La información de cada empresa está separada a nivel de base de datos. Un
usuario desactivado pierde el acceso de inmediato.

---

## En construcción

App del chofer y entregas con firma.

### Chofer y fecha al confirmar
Al confirmar un pedido se asigna el chofer y la fecha o franja de entrega
("mañana de 8 a 12").

### El chofer marca cada paso desde su celular
Acepta el pedido, lo recoge en bodega y lo entrega. El tablero de la oficina se
actualiza solo; nadie tiene que preguntar "¿ya salió?".

### Entrega con prueba
El cliente firma en el celular del chofer, con el nombre de quien recibe, la
hora y una foto si hace falta. El chofer registra el cobro: efectivo, cheque,
transferencia o crédito.

### Entregas parciales y fallidas
Si falta producto o el cliente rechaza una parte, se registra lo que de verdad
se entregó. Si el cliente estaba cerrado, el pedido vuelve a bodega y se
reprograma.

### Historial de cada pedido
Quién confirmó, quién entregó, a qué hora y por qué se canceló o se reprogramó.

---

## Próximo

Tu cliente se entera solo, y tú ves cómo va la operación.

### Avisos por correo en cada paso
Pedido recibido, confirmado con fecha de entrega, en camino y entregado.

### Página de seguimiento
Un link por pedido, sin contraseña, con el estado, la hora de cada paso y la
hora estimada de entrega. Se comparte por correo o por WhatsApp.

### Analíticas de ventas
Ventas por cliente, por producto y por período, comparadas con el período
anterior. Qué se vende más, quién compra más y qué está cayendo.

### Analíticas de operación
Cuánto tarda un pedido desde que entra hasta que se entrega, cuántas entregas
fallan y por qué, y cómo le va a cada chofer.
*Necesita:* las entregas con firma (En construcción).

---

## Después

Nellio empieza a anticipar.

### Clientes que dejaron de pedir
Aviso cuando un cliente que pedía con regularidad lleva más tiempo del normal
sin pedir, para llamarlo antes de perderlo.
*Necesita:* algunos meses de historial de pedidos.

### Pronóstico de pedidos por cliente
Nellio aprende cada cuánto pide cada cliente y qué suele pedir, y te avisa
quién probablemente va a pedir hoy o esta semana. El pedido de último minuto
deja de tomarte por sorpresa: puedes preparar o confirmar antes de que escriba.
*Necesita:* algunos meses de historial de pedidos.

### Pronóstico de demanda por producto
Cuánto se va a vender de cada producto la próxima semana y el próximo mes,
según el historial y la temporada. Sirve para planificar compras y producción.
*Necesita:* algunos meses de historial de pedidos.

### Entregas sin señal
El chofer registra la entrega aunque no tenga cobertura y se envía sola cuando
vuelve la señal.

### Factura electrónica al entregar
Con lo que realmente se entregó. Primero El Salvador (DTE de Hacienda), luego
Costa Rica y el resto de Centroamérica.

### Tu proceso, a tu medida
Pasos propios de tu empresa dentro del flujo estándar: cotización antes del
pedido, aprobación de crédito, paquetería en lugar de chofer propio.

---

## Explorando

Lo definimos contigo.

### Inventario y bodegas
Existencias, movimientos y bodegas, diseñados con la forma en que trabaja tu
bodega.

### Alertas de productos por agotarse
Cruza el inventario con el pronóstico de demanda y te avisa qué producto se va
a agotar y cuándo, con tiempo para pedirlo a tu proveedor.
*Necesita:* inventario y pronóstico de demanda por producto.

### Portal de pedidos para tus clientes
Que tus clientes hagan sus pedidos y vean su historial por su cuenta, sin pasar
por WhatsApp.

---

El orden de lo que viene se decide con las empresas que usan Nellio. Si algo de
esta lista te urge, o falta algo que tu operación necesita, cuéntanos.
