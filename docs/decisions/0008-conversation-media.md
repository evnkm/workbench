# 0008 Conversation diagrams and images

Mermaid remains Markdown in the durable conversation. The browser renders complete
fences on initial snapshots and replay, with the current appearance, and keeps the
source accessible when parsing fails. Rendering is lazy, serialized around Mermaid's
global configuration, and sanitized independently of ordinary Markdown.

Provider image events and tool results carry image references separately from bounded
text output. Local and inline tool images are copied into immutable, content-addressed
media before their completed item is published. Replayed completions preserve an
existing retained reference, even when the original temporary screenshot has gone.
Backups include media independently of optional job logs.

Image reads require an authenticated session and an image source referenced by the
requested item. Historical Markdown images can be retained on their first read.
The server never fetches remote image URLs and serves only validated raster formats;
arbitrary file downloads and executable SVG uploads are not part of this boundary.
