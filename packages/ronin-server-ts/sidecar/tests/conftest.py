import os
import sys

# Make the sidecar module importable (it lives one dir up).
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
