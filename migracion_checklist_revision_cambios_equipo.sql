-- El checklist completo de revision de equipo (12 puntos + estatus + estetica,
-- antes en Reparaciones) se mueve a Cambio de equipo por dinero -- aqui es
-- donde en verdad se revisa el equipo que trae el cliente, al comprarlo/cambiarlo.
ALTER TABLE cambios_equipo
  ADD COLUMN IF NOT EXISTS checklist_revision jsonb;
