import { useState } from 'react';
import VinSnapshot from './VinSnapshot';

export default function VinForm() {
    const [vin, setVin] = useState('');
    const [snapshot, setSnapshot] = useState(null);

    const handleSubmit = async (e) => {
        e.preventDefault();
        try {
            const res = await fetch('http://localhost:5000/api/vin/lookup', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ vin })
            });
            const data = await res.json();
            setSnapshot(data[0]); // assuming only one record for now
        } catch (err) {
            console.error(err);
        }
    };

    return (
        <div>
            <form onSubmit={handleSubmit}>
                <input
                    type="text"
                    placeholder="Enter VIN"
                    value={vin}
                    onChange={(e) => setVin(e.target.value)}
                />
                <button type="submit">Lookup</button>
            </form>

            {snapshot && <VinSnapshot data={snapshot} />}
        </div>
    );
}
