"""bowr processing worker.

The worker receives job-scoped capabilities through the internal API and never
holds a general database, Gemini or R2 credential (ARCHITECTURE section 2).
"""

__version__ = "0.0.0"
