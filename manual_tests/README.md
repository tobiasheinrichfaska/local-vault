# Manuelle Tests — local-vault

Anleitung für Menschen am Gerät, ohne Entwicklerwissen. Ergänzt die automatischen Tests.

## Stand

Der verschlüsselte Speicher ist automatisch getestet (Verschlüsselung, Regeln, Präfix, Texte). Nur
auf einem Gerät prüfbar ist:

- Gerätschlüssel und Daten bleiben nach dem Neuladen erhalten (IndexedDB).
- Der Gerätschlüssel lässt sich in iOS Safari und als Home-Bildschirm-App speichern; nach 7 Tagen
  ohne Nutzung löscht Safari den Speicher (Daten und Schlüssel gehen zusammen verloren).
- Die Passwort-Ableitung dauert auf einem Handy etwa eine Sekunde.
- Nach 5 Minuten im Hintergrund verlangt die App wieder das Passwort (Neuladen).
- „Neu beginnen“: Rückfrage erscheint, danach lädt die Seite neu und ist leer.

Die Testfälle entstehen mit der ersten Beispiel-App, die das Paket einbindet. Jede App, die das
Paket nutzt, wiederholt sie nach der Einbindung auf einem Gerät, nur mit erfundenen Daten.

## Umgebung

Wird mit der ersten Beispiel-App ergänzt (Gerät, Browser).
