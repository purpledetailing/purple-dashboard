import React from 'react';

function App() {
  return (
    <div className="flex h-screen font-sans">
      {/* Sidebar */}
      <aside className="w-48 bg-purple-600 text-white p-4 space-y-6">
        <h2 className="text-lg font-semibold">Dashboard</h2>
        <ul className="space-y-3 text-sm">
          <li className="hover:text-purple-200 cursor-pointer">Home</li>
          <li className="hover:text-purple-200 cursor-pointer">Reports</li>
          <li className="hover:text-purple-200 cursor-pointer">Settings</li>
        </ul>
      </aside>

      {/* Main Content */}
      <main className="flex-1 bg-purple-50 p-6">
        {/* Top Header */}
        <header className="bg-white p-4 shadow-sm mb-6 flex justify-between items-center rounded-md">
          <span className="font-medium text-gray-700 text-lg">Purple Dashboard</span>
          <div className="text-gray-500 text-sm">User</div>
        </header>

        {/* Cards */}
        <div className="grid grid-cols-2 gap-4">
          <div className="bg-white p-4 rounded-md shadow-sm">
            <h3 className="font-semibold mb-2">Card 1</h3>
            <p className="text-gray-600 text-sm">Some brief info here.</p>
          </div>
          <div className="bg-white p-4 rounded-md shadow-sm">
            <h3 className="font-semibold mb-2">Card 2</h3>
            <p className="text-gray-600 text-sm">Some brief info here.</p>
          </div>
        </div>
      </main>
    </div>
  );
}

export default App;
